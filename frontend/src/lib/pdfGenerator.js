import { jsPDF } from 'jspdf';

// Cache the logo so we only fetch once
let _logoDataUrl = null;

async function loadLogo() {
  if (_logoDataUrl) return _logoDataUrl;
  try {
    const resp = await fetch('/logo.png');
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        _logoDataUrl = reader.result;
        resolve(_logoDataUrl);
      };
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Read EXIF orientation and return a correctly-oriented data URL.
 */
function fixPhotoOrientation(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Draw to canvas at correct orientation
      const canvas = document.createElement('canvas');
      const maxDim = 800; // Reduce resolution for PDF embedding
      let w = img.width;
      let h = img.height;
      // Scale down
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * Generate a Herbicide Lease Sheet PDF.
 * @param {object} data - form data
 * @param {string[]} [photoDataUrls] - array of data URLs for photos (max 2)
 * Returns { blob, base64 }
 */
export async function generateLeaseSheetPdf(data, photoDataUrls = []) {
  // Fix photo orientations first
  const fixedPhotos = await Promise.all(
    photoDataUrls.slice(0, 2).map(url => fixPhotoOrientation(url))
  );

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();   // 612
  const pageH = doc.internal.pageSize.getHeight();  // 792
  const marginL = 36;
  const marginR = 36;
  const contentW = pageW - marginL - marginR;
  let y = 36;

  const drawRect = (x, yy, w, h) => {
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.rect(x, yy, w, h);
  };
  const halfW = contentW / 2;

  // ── Logo ──
  const logoData = await loadLogo();
  if (logoData) {
    doc.addImage(logoData, 'PNG', marginL, y, 100, 100);
  }

  // ── Title + Ticket No (aligned on same baseline) ──
  const titleY = y + 45;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(50, 80, 50);
  doc.text('Herbicide Lease Sheet', marginL + 120, titleY);
  doc.setTextColor(0);

  // Ticket No (same baseline as title)
  doc.setFontSize(12);
  doc.text(`No: ${data.ticket_number || ''}`, pageW - marginR, titleY, { align: 'right' });

  // Address line
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100);
  doc.text('7077 252 Road, Pineview, BC, Canada, V1J 8E3', marginL + 120, titleY + 14);
  doc.text('Tel: 250.261.9544 | office@pineviewmanagement.com', marginL + 120, titleY + 24);
  doc.setTextColor(0);

  y += 110;

  // ── Customer / Area / LSD ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Customer/Area/LSD:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.customer || ''} / ${data.area || ''} / ${data.lsdOrPipeline || ''}`, marginL + 110, y);
  y += 14;

  // Date + Time
  doc.setFont('helvetica', 'bold');
  doc.text('Date:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.date || '', marginL + 32, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Time:', marginL + 160, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.time || '', marginL + 192, y);
  y += 14;

  // Applicators
  doc.setFont('helvetica', 'bold');
  doc.text('Applicators:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text((data.applicators || []).join(', '), marginL + 65, y);
  y += 14;

  // ── Wind / Location Type ──
  const tH = 34;
  drawRect(marginL, y, halfW, tH);
  drawRect(marginL + halfW, y, halfW, tH);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('Wind Direction/Speed:', marginL + 3, y + 11);
  doc.text('Location Type:', marginL + halfW + 3, y + 11);
  doc.setFont('helvetica', 'normal');
  const windText = `${(data.windDirection || []).join(', ')} ${data.windSpeed ? data.windSpeed + ' km/h' : ''}`.trim();
  doc.text(windText, marginL + 3, y + 25);
  doc.text((data.locationTypes || []).join(', '), marginL + halfW + 3, y + 25);
  y += tH;

  // Temp row
  drawRect(marginL, y, halfW, 18);
  drawRect(marginL + halfW, y, halfW, 18);
  doc.setFont('helvetica', 'bold');
  doc.text('Temp:', marginL + 3, y + 13);
  doc.setFont('helvetica', 'normal');
  doc.text(data.temperature ? `${data.temperature}°C` : '', marginL + 34, y + 13);
  y += 18;

  // ── Noxious Weeds ──
  const noxH = 40;
  drawRect(marginL, y, halfW, noxH);
  drawRect(marginL + halfW, y, halfW, noxH);
  doc.setFont('helvetica', 'bold');
  doc.text('Noxious Weeds:', marginL + 3, y + 11);
  doc.setFont('helvetica', 'normal');
  // Merge standard-list selections + typed custom weeds. If "Other" is present
  // we replace it with the custom list so the PDF reads cleanly.
  const selectedWeeds = data.noxiousWeedsSelected || [];
  const customWeeds = data.customWeeds || [];
  const displayWeeds = [
    ...selectedWeeds.filter(w => w.toLowerCase() !== 'other'),
    ...customWeeds,
  ];
  const noxLines = doc.splitTextToSize(displayWeeds.join(', '), halfW - 8);
  doc.text(noxLines, marginL + 3, y + 23);
  y += noxH;

  // ── Products Applied ──
  const prodH = 46;
  drawRect(marginL, y, contentW, prodH);
  doc.setFont('helvetica', 'bold');
  doc.text('Products Applied:', marginL + 3, y + 11);
  doc.setFont('helvetica', 'normal');
  const herbLines = doc.splitTextToSize((data.herbicidesUsed || []).join(', '), contentW - 8);
  doc.text(herbLines, marginL + 3, y + 23);
  y += prodH;

  // ── Area Treated / Total Product ──
  const areaH = 20;
  drawRect(marginL, y, contentW, areaH);
  doc.setFont('helvetica', 'bold');
  doc.text('Area Treated:', marginL + 3, y + 13);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.areaTreated || '___'} ha`, marginL + 70, y + 13);
  doc.setFont('helvetica', 'bold');
  doc.text('Total Product:', marginL + 180, y + 13);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.totalLiters || '___'} L`, marginL + 255, y + 13);
  y += areaH;

  // ── Total Distance Sprayed ──
  if (data.totalDistanceSprayed) {
    const distH = 18;
    drawRect(marginL, y, contentW, distH);
    doc.setFont('helvetica', 'bold');
    doc.text('Total Distance Sprayed:', marginL + 3, y + 13);
    doc.setFont('helvetica', 'normal');
    doc.text(`${data.totalDistanceSprayed} m`, marginL + 110, y + 13);
    y += distH;
  }

  // ── Spray Type / Spray Method ──
  const spH = 34;
  drawRect(marginL, y, halfW, spH);
  drawRect(marginL + halfW, y, halfW, spH);
  doc.setFont('helvetica', 'bold');
  doc.text('Spray Type:', marginL + 3, y + 11);
  doc.text('Spray Method:', marginL + halfW + 3, y + 11);
  doc.setFont('helvetica', 'normal');
  doc.text((data.sprayType || []).join(', '), marginL + 3, y + 25);
  doc.text((data.sprayMethod || []).join(', '), marginL + halfW + 3, y + 25);
  y += spH;

  // ── Access Road (if applicable) ──
  if (data.isAccessRoad || (data.locationTypes || []).some(t => ['Access Road', 'Roadside'].includes(t))) {
    const roadH = 36;
    drawRect(marginL, y, contentW, roadH);
    doc.setFont('helvetica', 'bold');
    doc.text('Roadside Details:', marginL + 3, y + 11);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(`Distance: ${data.roadsideKm || '___'} km   Herbicides: ${(data.roadsideHerbicides || []).join(', ')}`, marginL + 3, y + 23);
    doc.text(`Liters: ${data.roadsideLiters || '___'} L   Area: ${data.roadsideAreaTreated || '___'} ha`, marginL + 3, y + 33);
    y += roadH;
  }

  // ── Comments ──
  const commH = 50;
  drawRect(marginL, y, contentW, commH);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('Comments:', marginL + 3, y + 11);
  doc.setFont('helvetica', 'normal');
  const commLines = doc.splitTextToSize(data.comments || '', contentW - 8);
  doc.text(commLines, marginL + 3, y + 23);
  y += commH;

  // ── Photos at bottom ──
  if (fixedPhotos.length > 0) {
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('Photos:', marginL, y + 10);
    y += 14;

    const maxPhotoH = pageH - y - 30; // remaining space minus label
    const slotW = Math.min(halfW - 10, 250);

    // Get actual image dimensions to preserve aspect ratio
    const photoDims = await Promise.all(
      fixedPhotos.slice(0, 2).map(src => new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 1, h: 1 });
        img.src = src;
      }))
    );

    for (let i = 0; i < Math.min(fixedPhotos.length, 2); i++) {
      const px = marginL + i * (slotW + 10);
      const dim = photoDims[i];
      const ratio = dim.h / dim.w;
      // Fit within slotW width, but respect maxPhotoH
      let drawW = slotW;
      let drawH = slotW * ratio;
      if (drawH > maxPhotoH) {
        drawH = maxPhotoH;
        drawW = maxPhotoH / ratio;
      }
      try {
        doc.addImage(fixedPhotos[i], 'JPEG', px, y, drawW, drawH);
      } catch {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7);
        doc.text(`[Photo ${i + 1}]`, px + 4, y + 12);
      }
      // Label
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      const label = i === 0 ? 'LSD / Location ID' : 'Site Photo';
      doc.text(label, px, y + drawH + 10);
    }
  }

  // ── Output ──
  const blob = doc.output('blob');
  const base64 = doc.output('datauristring').split(',')[1];
  return { blob, base64 };
}
