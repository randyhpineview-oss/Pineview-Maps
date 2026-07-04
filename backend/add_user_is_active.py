#!/usr/bin/env python3
"""
Add is_active column to users table
"""
import os
import psycopg
from psycopg.rows import dict_row

# Get database URL from environment or use default
DB_URL = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost/pineview")

def add_user_is_active():
    """Add is_active column to users table for soft-delete support"""
    
    sql_statements = [
        # Add is_active column with default True for existing users
        """
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE NOT NULL
        """,
    ]
    
    print(f"Connecting to database...")
    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor() as cur:
                for sql in sql_statements:
                    print(f"Executing: {sql.strip()}")
                    cur.execute(sql)
                conn.commit()
                print("Migration completed successfully!")
    except Exception as e:
        print(f"Error: {e}")
        print("\nMake sure to set DATABASE_URL environment variable or run this on Render directly")

if __name__ == "__main__":
    add_user_is_active()
