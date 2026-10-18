require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Database Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// --- AUTOMATIC DATABASE INITIALIZATION FROM schema.sql ---
async function initializeDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schemaSql);
      console.log('✅ Database schema and seed data verified/initialized successfully.');
    } else {
      console.warn('⚠️ Warning: schema.sql file not found in root directory.');
    }
  } catch (err) {
    console.error('❌ Error executing schema.sql on startup:', err.message);
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

// --- AUTHENTICATION MIDDLEWARE ---
function verifyAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

function verifyAdmin(req, res, next) {
  verifyAuth(req, res, () => {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }
    next();
  });
}

// --- AUTH ENDPOINTS ---
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password.' });

    const user = result.rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated.' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: 'Invalid email or password.' });

    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, role: user.role, name: user.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- COUPON CREATION (ADMIN) ---
app.post('/api/coupons/generate', verifyAdmin, async (req, res) => {
  const { offer, terms, maxUses, cooldownDays, expiresAt, suffix } = req.body;
  
  if (!['FS', 'BL'].includes(suffix)) {
    return res.status(400).json({ error: 'Suffix must be either FS or BL.' });
  }

  const randomNum = Math.floor(10000000 + Math.random() * 90000000);
  const code = `CN${randomNum}${suffix}`;

  try {
    // Generate QR Code data URL to return instantly
    const qrDataUrl = await QRCode.toDataURL(code);

    const result = await pool.query(
      `INSERT INTO coupons (code, offer_details, terms_and_conditions, max_uses, cooldown_days, expires_at, suffix)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [code, offer, terms, maxUses || 1, cooldownDays || 0, expiresAt, suffix]
    );

    res.json({ coupon: result.rows[0], qrCode: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET ALL COUPONS (ADMIN) ---
app.get('/api/coupons', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- EDIT COUPON (ADMIN) - Updates details without changing code/QR ---
app.put('/api/coupons/:id', verifyAdmin, async (req, res) => {
  const { offer, terms, maxUses, cooldownDays, expiresAt, isActive } = req.body;
  try {
    const result = await pool.query(
      `UPDATE coupons 
       SET offer_details = COALESCE($1, offer_details),
           terms_and_conditions = COALESCE($2, terms_and_conditions),
           max_uses = COALESCE($3, max_uses),
           cooldown_days = COALESCE($4, cooldown_days),
           expires_at = COALESCE($5, expires_at),
           is_active = COALESCE($6, is_active)
       WHERE id = $7 RETURNING *`,
      [offer, terms, maxUses, cooldownDays, expiresAt, isActive, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Coupon not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DELETE OR DEACTIVATE COUPON (ADMIN) ---
app.delete('/api/coupons/:id', verifyAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
    res.json({ message: 'Coupon deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- REDEMPTION LOGIC (ADMIN & STAFF) ---
app.post('/api/coupons/redeem', verifyAuth, async (req, res) => {
  const { code, customerName } = req.body;

  // 1. Structure check: starts with CN, ends with FS or BL
  if (!/^CN.*(FS|BL)$/.test(code)) {
    return res.status(400).json({ error: 'Fraudulent/Unrecognized coupon format (Not created by Chicken Nation).' });
  }

  try {
    const couponRes = await pool.query('SELECT * FROM coupons WHERE code = $1', [code]);
    if (couponRes.rows.length === 0) {
      return res.status(404).json({ error: 'Coupon code not found in system database.' });
    }

    const c = couponRes.rows[0];

    // 2. Active status check
    if (!c.is_active) {
      return res.status(400).json({ error: 'This coupon has been deactivated.' });
    }

    // 3. Expiration check
    const now = new Date();
    if (new Date(c.expires_at) < now) {
      return res.status(400).json({ error: 'This coupon has expired.' });
    }

    // 4. Max uses check
    if (c.current_uses >= c.max_uses) {
      return res.status(400).json({ error: 'Coupon usage limit has already been fully reached.' });
    }

    // 5. Cooldown period check for multi-use coupons
    if (c.current_uses > 0 && c.cooldown_days > 0 && c.last_redeemed_at) {
      const nextValidDate = new Date(c.last_redeemed_at);
      nextValidDate.setDate(nextValidDate.getDate() + c.cooldown_days);

      if (now < nextValidDate) {
        const daysRemaining = Math.ceil((nextValidDate - now) / (1000 * 60 * 60 * 24));
        return res.status(400).json({ 
          error: `Cooldown active. This multi-use coupon cannot be used yet. Try again in ${daysRemaining} day(s).` 
        });
      }
    }

    // 6. Execute Transaction
    await pool.query('BEGIN');
    await pool.query(
      `UPDATE coupons 
       SET current_uses = current_uses + 1, last_redeemed_at = NOW() 
       WHERE id = $1`,
      [c.id]
    );

    await pool.query(
      `INSERT INTO redemption_logs (coupon_id, coupon_code, staff_id, staff_name, customer_name) 
       VALUES ($1, $2, $3, $4, $5)`,
      [c.id, c.code, req.user.id, req.user.name, customerName || 'Anonymous']
    );
    await pool.query('COMMIT');

    // Fetch updated coupon state to return clean data to frontend
    const updatedRes = await pool.query('SELECT * FROM coupons WHERE id = $1', [c.id]);
    const updatedCoupon = updatedRes.rows[0];

    res.json({ 
      success: true, 
      message: 'Coupon redeemed successfully!', 
      coupon: updatedCoupon,
      offer: updatedCoupon.offer_details,
      customer: customerName || 'Anonymous'
    });

  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// --- REPORTS / REDEMPTION LOGS ---
app.get('/api/reports', verifyAuth, async (req, res) => {
  try {
    const reports = await pool.query(
      `SELECT r.id, r.coupon_code, r.customer_name, r.staff_name, r.redeemed_at, c.offer_details, c.suffix
       FROM redemption_logs r
       JOIN coupons c ON r.coupon_id = c.id
       ORDER BY r.redeemed_at DESC`
    );
    res.json(reports.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WIPE EVERYTHING (ADMIN) ---
app.delete('/api/reports', verifyAdmin, async (req, res) => {
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM redemption_logs');
    await pool.query('DELETE FROM coupons');
    await pool.query('COMMIT');

    res.json({ message: 'All system data (reports and coupons) wiped successfully.' });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// --- STAFF MANAGEMENT (ADMIN) ---
app.get('/api/staff', verifyAdmin, async (req, res) => {
  try {
    const staff = await pool.query('SELECT id, name, email, role, is_active, created_at FROM users WHERE role = $1', ['STAFF']);
    res.json(staff.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staff', verifyAdmin, async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'STAFF') RETURNING id, name, email, role`,
      [name, email, hash]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/staff/:id', verifyAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1 AND role = $2', [req.params.id, 'STAFF']);
    res.json({ message: 'Staff deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

// Initialize database schema first, then start server
initializeDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Chicken Nation Coupons running live on port ${PORT}`);
  });
});