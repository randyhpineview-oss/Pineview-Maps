from io import BytesIO
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors
from datetime import datetime
from typing import Dict, Any

def generate_lease_sheet_pdf(data: Dict[str, Any]) -> bytes:
    """
    Generate a PDF herbicide lease sheet from form data.
    
    Args:
        data: Dictionary containing lease sheet form data
    
    Returns:
        PDF content as bytes
    """
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=72, leftMargin=72, topMargin=72, bottomMargin=18)
    
    # Get styles
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=18,
        spaceAfter=30,
        alignment=1  # Center alignment
    )
    heading_style = ParagraphStyle(
        'CustomHeading',
        parent=styles['Heading2'],
        fontSize=14,
        spaceAfter=12,
        spaceBefore=20
    )
    normal_style = styles['Normal']
    
    # Build story (content)
    story = []
    
    # Title
    story.append(Paragraph("HERBICIDE LEASE SHEET", title_style))
    story.append(Spacer(1, 20))
    
    # Basic Information
    story.append(Paragraph("Application Details", heading_style))
    
    basic_info = [
        ['Date:', data.get('date', '')],
        ['Time:', data.get('time', '')],
        ['Customer:', data.get('customer', '')],
        ['Area:', data.get('area', '')],
        ['LSD/Pipeline:', data.get('lsdOrPipeline', '')],
        ['Ticket Number:', data.get('ticket_number', '')]
    ]
    
    basic_table = Table(basic_info, colWidths=[2*inch, 4*inch])
    basic_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.whitesmoke),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
        ('BACKGROUND', (0, 0), (0, -1), colors.lightgrey),
    ]))
    story.append(basic_table)
    story.append(Spacer(1, 20))
    
    # Weather Conditions
    story.append(Paragraph("Weather Conditions", heading_style))
    
    weather_info = [
        ['Temperature:', f"{data.get('temperature', '')}°C"],
        ['Wind Speed:', f"{data.get('windSpeed', '')} km/h"],
        ['Wind Direction:', ', '.join(data.get('windDirection', []))],
    ]
    
    weather_table = Table(weather_info, colWidths=[2*inch, 4*inch])
    weather_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.whitesmoke),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
        ('BACKGROUND', (0, 0), (0, -1), colors.lightgrey),
    ]))
    story.append(weather_table)
    story.append(Spacer(1, 20))
    
    # Application Details
    story.append(Paragraph("Application Details", heading_style))
    
    app_info = [
        ['Spray Type:', ', '.join(data.get('sprayType', []))],
        ['Spray Method:', ', '.join(data.get('sprayMethod', []))],
        ['Applicators:', ', '.join(data.get('applicators', []))],
        ['Location Types:', ', '.join(data.get('locationTypes', []))],
        ['Noxious Weeds:', ', '.join(data.get('noxiousWeedsSelected', []))],
        ['Herbicides Used:', ', '.join(data.get('herbicidesUsed', []))],
        ['Total Liters:', data.get('totalLiters', '')],
        ['Area Treated:', data.get('areaTreated', '')],
    ]
    
    app_table = Table(app_info, colWidths=[2*inch, 4*inch])
    app_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.whitesmoke),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
        ('BACKGROUND', (0, 0), (0, -1), colors.lightgrey),
    ]))
    story.append(app_table)
    
    # Access Road section (if applicable)
    if data.get('isAccessRoad'):
        story.append(Spacer(1, 20))
        story.append(Paragraph("Access Road Treatment", heading_style))
        
        road_info = [
            ['Roadside Distance:', f"{data.get('roadsideKm', '')} km"],
            ['Roadside Herbicides:', ', '.join(data.get('roadsideHerbicides', []))],
            ['Roadside Liters:', data.get('roadsideLiters', '')],
            ['Roadside Area:', data.get('roadsideAreaTreated', '')],
        ]
        
        road_table = Table(road_info, colWidths=[2*inch, 4*inch])
        road_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.whitesmoke),
            ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
            ('BACKGROUND', (0, 0), (0, -1), colors.lightgrey),
        ]))
        story.append(road_table)
    
    # Comments
    if data.get('comments'):
        story.append(Spacer(1, 20))
        story.append(Paragraph("Comments", heading_style))
        story.append(Paragraph(data.get('comments', ''), normal_style))
    
    # Photos section
    if data.get('photo_urls'):
        story.append(Spacer(1, 20))
        story.append(Paragraph("Photos", heading_style))
        for url in data.get('photo_urls', []):
            story.append(Paragraph(f"• {url}", normal_style))
    
    # Footer
    story.append(Spacer(1, 30))
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", normal_style))
    
    # Build PDF
    doc.build(story)
    
    # Get PDF content
    buffer.seek(0)
    return buffer.getvalue()
