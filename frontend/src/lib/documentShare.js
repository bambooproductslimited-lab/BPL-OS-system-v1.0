// Renders a printable document node (an Estimate/Quotation/Invoice/Receipt
// preview) to a real PDF client-side, then hands it to the device's native
// share sheet (email, WhatsApp, text message, AirDrop, ...) via the Web
// Share API. Desktop browsers that can't share files just get the PDF
// downloaded instead, so it can be attached/shared manually. Elements
// marked `.no-print` (the action buttons themselves, the dialog backdrop)
// are excluded from the rendered page.
//
// jspdf/html2canvas (~600KB combined) are dynamically imported here rather
// than at module scope, so they land in their own chunk and only download
// when someone actually clicks Share — not on every page load.
async function renderToPdfBlob(node) {
  var jsPDFModule = await import('jspdf');
  var html2canvasModule = await import('html2canvas');
  var jsPDF = jsPDFModule.default;
  var html2canvas = html2canvasModule.default;

  var canvas = await html2canvas(node, {
    scale: 2,
    backgroundColor: '#ffffff',
    ignoreElements: function (el) { return !!(el.classList && el.classList.contains('no-print')); }
  });

  var pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  var pageWidth = pdf.internal.pageSize.getWidth();
  var pageHeight = pdf.internal.pageSize.getHeight();
  var imgWidth = pageWidth;
  var imgHeight = (canvas.height * imgWidth) / canvas.width;
  var imgData = canvas.toDataURL('image/png');

  var heightLeft = imgHeight;
  var position = 0;
  pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;
  while (heightLeft > 0) {
    position -= pageHeight;
    pdf.addPage();
    pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }

  return pdf.output('blob');
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// node: the DOM element to render. filename: e.g. "Invoice-INV-2026-0001.pdf".
// shareTitle/shareText: passed to the native share sheet when available.
export async function shareOrDownloadPdf(node, filename, shareTitle, shareText) {
  var blob = await renderToPdfBlob(node);
  var file = new File([blob], filename, { type: 'application/pdf' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: shareTitle, text: shareText });
    return 'shared';
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}
