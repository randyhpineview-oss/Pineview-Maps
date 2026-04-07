from io import BytesIO
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch, cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
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
    doc = SimpleDocTemplate(buffer, pagesize=letter, rightMargin=36, leftMargin=36, topMargin=36, bottomMargin=36)
    
    # Get styles
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=14,
        spaceAfter=12,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold'
    )
    
    normal_style = ParagraphStyle(
        'Normal',
        parent=styles['Normal'],
        fontSize=10,
        spaceAfter=6,
        fontName='Helvetica'
    )
    
    # Build story (content)
    story = []
    
    # Header section
    header_data = [
        ["PINEVIEW AERIAL INC.", ""],
        ["Box 370, Sundre, Alberta", ""],
        ["Phone: (403) 638-2428", ""],
        ["Fax: (403) 638-2429", ""],
    ]
    
    header_table = Table(header_data, colWidths=[4*inch, 3*inch])
    header_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (0, -1), 'LEFT'),
        ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(header_table)
    story.append(Spacer(1, 12))
    
    # Title
    story.append(Paragraph("HERBICIDE LEASE SHEET", title_style))
    story.append(Spacer(1, 12))
    
    # Main information section
    main_info = [
        ["Date:", data.get('date', ''), "Time:", data.get('time', '')],
        ["Customer:", data.get('customer', ''), "Ticket No.:", data.get('ticket_number', '')],
        ["Area:", data.get('area', ''), ""],
        ["LSD/Pipeline:", data.get('lsdOrPipeline', ''), ""],
    ]
    
    main_table = Table(main_info, colWidths=[1.5*inch, 2.5*inch, 1.5*inch, 2.5*inch])
    main_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('ALIGN', (2, 0), (2, -1), 'RIGHT'),
        ('ALIGN', (3, 0), (3, -1), 'LEFT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('FONTNAME', (0, 0), (0, 7), 'Helvetica-Bold'),
        ('FONTNAME', (2, 0), (2, 7), 'Helvetica-Bold'),
    ]))
    story.append(main_table)
    story.append(Spacer(1, 12))
    
    # Weather conditions
    weather_info = [
        ["Temperature:", f"{data.get('temperature', '')}°C", "Wind Speed:", f"{data.get('windSpeed', '')} km/h"],
        ["Wind Direction:", ', '.join(data.get('windDirection', [])), "", ""],
    ]
    
    weather_table = Table(weather_info, colWidths=[1.5*inch, 2.5*inch, 1.5*inch, 2.5*inch])
    weather_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('FONTNAME', (0, 0), (0, 1), 'Helvetica-Bold'),
        ('FONTNAME', (2, 0), (2, 1), 'Helvetica-Bold'),
    ]))
    story.append(weather_table)
    story.append(Spacer(1, 12))
    
    # Application details
    app_info = [
        ["Applicators:", ', '.join(data.get('applicators', [])), "Location Types:", ', '.join(data.get('locationTypes', []))],
        ["Spray Type:", ', '.join(data.get('sprayType', [])), "Spray Method:", ', '.join(data.get('sprayMethod', []))],
        ["Noxious Weeds:", ', '.join(data.get('noxiousWeedsSelected', [])), ""],
        ["Herbicides Used:", ', '.join(data.get('herbicidesUsed', [])), ""],
        ["Total Liters:", data.get('totalLiters', ''), "Area Treated:", data.get('areaTreated', '')],
    ]
    
    app_table = Table(app_info, colWidths=[1.5*inch, 2.5*inch, 1.5*inch, 2.5*inch])
    app_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('FONTNAME', (0, 0), (0, 4), 'Helvetica-Bold'),
        ('FONTNAME', (2, 0), (2, 4), 'Helvetica-Bold'),
    ]))
    story.append(app_table)
    story.append(Spacer(1, 12))
    
    # Access Road section (if applicable)
    if data.get('isAccessRoad'):
        road_info = [
            ["ACCESS ROAD", ""],
            ["Roadside Distance:", f"{data.get('roadsideKm', '')} km", ""],
            ["Roadside Herbicides:", ', '.join(data.get('roadsideHerbicides', [])), ""],
            ["Roadside Liters:", data.get('roadsideLiters', ''), "Roadside Area:", data.get('roadsideAreaTreated', '')],
        ]
        
        road_table = Table(road_info, colWidths=[1.5*inch, 2.5*inch, 1.5*inch, 2.5*inch])
        road_table.setStyle(TableStyle([
            ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('FONTNAME', (0, 0), (0, 3), 'Helvetica-Bold'),
            ('FONTNAME', (2, 0), (2, 3), 'Helvetica-Bold'),
            ('BACKGROUND', (0, 0), (3, 0), colors.lightgrey),
        ]))
        story.append(road_table)
        story.append(Spacer(1, 12))
    
    # Comments
    if data.get('comments'):
        comments_data = [
            ["COMMENTS:", ""],
            [data.get('comments', ''), ""],
        ]
        
        comments_table = Table(comments_data, colWidths=[1.5*inch, 5.5*inch])
        comments_table.setStyle(TableStyle([
            ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('FONTNAME', (0, 0), (0, 0), 'Helvetica-Bold'),
            ('BACKGROUND', (0, 0), (0, 0), colors.lightgrey),
        ]))
        story.append(comments_table)
        story.append(Spacer(1, 12))
    
    # Photos section
    if data.get('photo_urls'):
        photos_data = [
            ["PHOTOS ATTACHED:", ""],
            [f"{len(data.get('photo_urls', []))} photos uploaded to Dropbox", ""],
        ]
        
        photos_table = Table(photos_data, colWidths=[1.5*inch, 5.5*inch])
        photos_table.setStyle(TableStyle([
            ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('FONTNAME', (0, 0), (0, 0), 'Helvetica-Bold'),
            ('BACKGROUND', (0, 0), (0, 0), colors.lightgrey),
        ]))
        story.append(photos_table)
        story.append(Spacer(1, 12))
    
    # Footer
    footer_data = [
        ["", ""],
        ["", ""],
        ["_________________________", "_________________________"],
        ["Applicator Signature", "Date"],
    ]
    
    footer_table = Table(footer_data, colWidths=[3.5*inch, 3.5*inch])
    footer_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('FONTNAME', (2, 2), (3, 2), 'Helvetica-Bold'),
    ]))
    story.append(footer_table)
    
    # Build PDF
    doc.build(story)
    
    # Get PDF content
    buffer.seek(0)
    return buffer.getvalue()
