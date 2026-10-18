-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. USERS & ROLES
CREATE TYPE user_role AS ENUM ('ADMIN', 'STAFF');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'STAFF',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. COUPONS
CREATE TYPE coupon_suffix AS ENUM ('FS', 'BL');

CREATE TABLE coupons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL, -- e.g., CN123456FS
    offer_details TEXT NOT NULL, 
    terms_and_conditions TEXT,
    max_uses INT NOT NULL DEFAULT 1,
    current_uses INT NOT NULL DEFAULT 0,
    cooldown_days INT DEFAULT 0, 
    last_redeemed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    suffix coupon_suffix NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. REDEMPTION LOGS & REPORTS
CREATE TABLE redemption_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    coupon_id UUID REFERENCES coupons(id) ON DELETE CASCADE,
    coupon_code VARCHAR(50) NOT NULL,
    staff_id UUID REFERENCES users(id) ON DELETE SET NULL,
    staff_name VARCHAR(100) NOT NULL,
    customer_name VARCHAR(100) DEFAULT 'Anonymous',
    redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. INSERT DEFAULT ADMIN ACCOUNT
-- Email: admin@chickennation.com | Password: password123
INSERT INTO users (name, email, password_hash, role) 
VALUES ('Super Admin', 'admin@chickennation.com', '$2b$10$X7vQ43j/K8JmE0v1/X10ouJ5C9n7H9T4Fw5M0QG1VpP4T7k9m5y2y', 'ADMIN');