#!/usr/bin/env python3
"""
Add lease sheet fields to spray_records table
"""
import psycopg
from psycopg.rows import dict_row

# Database connection (adjust as needed)
DB_URL = "postgresql://postgres:password@localhost/pineview"

def add_lease_sheet_fields():
    """Add new columns to spray_records table for lease sheet functionality"""
    
    sql_statements = [
        # Add ticket_number column
        """
        ALTER TABLE spray_records 
        ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(20)
        """,
        
        # Add lease_sheet_data column
        """
        ALTER TABLE spray_records 
        ADD COLUMN IF NOT EXISTS lease_sheet_data JSONB
        """,
        
        # Add pdf_url column
        """
        ALTER TABLE spray_records 
        ADD COLUMN IF NOT EXISTS pdf_url TEXT
        """,
        
        # Add photo_urls column
        """
        ALTER TABLE spray_records 
        ADD COLUMN IF NOT EXISTS photo_urls JSONB DEFAULT '[]'
        """,
        
        # Add index for ticket_number
        """
        CREATE INDEX IF NOT EXISTS idx_spray_records_ticket_number 
        ON spray_records(ticket_number)
        """,
    ]
    
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            for sql in sql_statements:
                print(f"Executing: {sql.strip()}")
                cur.execute(sql)
            conn.commit()
            print("Migration completed successfully!")

if __name__ == "__main__":
    add_lease_sheet_fields()
