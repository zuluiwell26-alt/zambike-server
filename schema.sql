-- ZAMBIKE DATABASE SCHEMA

-- Users table (both passengers and riders)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('passenger', 'rider')),
    password_hash TEXT NOT NULL,
    profile_photo TEXT,
    license_photo TEXT,
    bike_plate TEXT,
    is_approved BOOLEAN DEFAULT FALSE,
    is_online BOOLEAN DEFAULT FALSE,
    rating NUMERIC(3,2) DEFAULT 5.00,
    total_rides INTEGER DEFAULT 0,
    total_earnings NUMERIC DEFAULT 0,
    total_trips INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lat NUMERIC(10,7);
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lng NUMERIC(10,7);
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_lat NUMERIC(10,7);
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_lng NUMERIC(10,7);
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_address TEXT;

-- Rider locations (updated in real time)
CREATE TABLE IF NOT EXISTS rider_locations (
    rider_id INTEGER PRIMARY KEY REFERENCES users(id),
    latitude NUMERIC(10,7) NOT NULL,
    longitude NUMERIC(10,7) NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Rides table
CREATE TABLE IF NOT EXISTS rides (
    id SERIAL PRIMARY KEY,
    passenger_id INTEGER REFERENCES users(id),
    rider_id INTEGER REFERENCES users(id),
    pickup_lat NUMERIC(10,7) NOT NULL,
    pickup_lng NUMERIC(10,7) NOT NULL,
    pickup_address TEXT,
    dest_lat NUMERIC(10,7) NOT NULL,
    dest_lng NUMERIC(10,7) NOT NULL,
    dest_address TEXT,
    distance_km NUMERIC(6,2),
    fare NUMERIC(10,2),
    zambike_cut NUMERIC(10,2),
    rider_earnings NUMERIC(10,2),
    status TEXT DEFAULT 'requested' CHECK (status IN (
        'requested', 'accepted', 'arriving', 'in_progress', 'completed', 'cancelled'
    )),
    payment_method TEXT CHECK (payment_method IN ('airtel', 'mtn')),
    payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed')),
    payment_reference TEXT,
    requested_at TIMESTAMP DEFAULT NOW(),
    accepted_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    cancel_reason TEXT
);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    ride_id INTEGER REFERENCES rides(id),
    passenger_id INTEGER REFERENCES users(id),
    rider_id INTEGER REFERENCES users(id),
    amount NUMERIC(10,2) NOT NULL,
    zambike_cut NUMERIC(10,2) NOT NULL,
    rider_earnings NUMERIC(10,2) NOT NULL,
    network TEXT NOT NULL CHECK (network IN ('airtel', 'mtn')),
    reference TEXT UNIQUE,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Ratings table
CREATE TABLE IF NOT EXISTS ratings (
    id SERIAL PRIMARY KEY,
    ride_id INTEGER REFERENCES rides(id),
    rated_by INTEGER REFERENCES users(id),
    rated_user INTEGER REFERENCES users(id),
    stars INTEGER CHECK (stars BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Fare settings (admin can change these)
CREATE TABLE IF NOT EXISTS fare_settings (
    id SERIAL PRIMARY KEY,
    base_fare NUMERIC DEFAULT 10.00,
    per_km_rate NUMERIC DEFAULT 5.00,
    zambike_percentage NUMERIC DEFAULT 10,
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO fare_settings (base_fare, per_km_rate, zambike_percentage)
VALUES (10.00, 5.00, 10)
ON CONFLICT DO NOTHING;

-- Admin table
CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
