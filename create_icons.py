from PIL import Image
import sys
import os

# Configuration
INPUT_IMAGE = "frontend/public/logo.png"  # Save your uploaded image here
OUTPUT_DIR = "frontend/public"
SIZES = [192, 512]

def create_icons():
    # Check if input exists
    if not os.path.exists(INPUT_IMAGE):
        print(f"Error: {INPUT_IMAGE} not found!")
        print("Please save your uploaded logo image to frontend/public/logo.png")
        return False
    
    # Open the image
    img = Image.open(INPUT_IMAGE)
    
    # Convert to RGBA if necessary (for transparency support)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    
    # Create icons for each size
    for size in SIZES:
        # Resize with high quality
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        
        # Save as PNG
        output_path = os.path.join(OUTPUT_DIR, f"icon-{size}.png")
        resized.save(output_path, 'PNG', optimize=True)
        print(f"Created: {output_path}")
    
    print("\nDone! Icons created successfully.")
    print("You can now delete the logo.png file if you want.")
    return True

if __name__ == "__main__":
    create_icons()
