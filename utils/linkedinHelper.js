// linkedinHelper.js - Improved version that explicitly handles URL parameters
// Helper function to extract LinkedIn identifier from URL
function extractLinkedInId(url) {
  if (!url) return null;
  
  // IMPROVED: Updated regex to explicitly handle URL parameters and trailing content
  // This regex stops at ?, /, or end of string after capturing the profile ID
  const match = url.match(/linkedin\.com\/in\/([\w\-%.0-9]+)(?:[/?]|$)/i);
  return match ? match[1].toLowerCase() : null;
}

// Helper function to check if a LinkedIn URL already exists
async function checkLinkedInDuplicate(url, Profile) {
  if (!url) return null;
  
  const linkedinId = extractLinkedInId(url);
  if (!linkedinId) return null;

  try {
    const existingProfile = await Profile.findOne({ linkedinId });
    return existingProfile ? {
      exists: true,
      message: 'A profile with this LinkedIn URL already exists'
    } : null;
  } catch (error) {
    console.error('Error checking LinkedIn duplicate:', error);
    return null;
  }
}

module.exports = {
  extractLinkedInId,
  checkLinkedInDuplicate
};