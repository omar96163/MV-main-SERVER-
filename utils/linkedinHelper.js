function extractLinkedInId(url) {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([\w\-%.0-9]+)(?:[/?]|$)/i);
  return match ? match[1].toLowerCase() : null;
}

module.exports = { extractLinkedInId };
