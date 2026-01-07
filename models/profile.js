const mongoose = require("mongoose");

// Function to extract LinkedIn identifier from URL
function extractLinkedInId(url) {
  if (!url) return null;
  // Match the pattern: linkedin.com/in/USERNAME
  const match = url.match(/linkedin\.com\/in\/([^/?]+)/);
  return match ? match[1].toLowerCase() : null;
}

const profileSchema = new mongoose.Schema(
  {
    name: String,
    jobTitle: String,
    company: String,
    location: String,
    industry: String,
    experience: Number,
    seniorityLevel: String,
    skills: [String],
    education: String,
    workExperience: String,
    email: String,
    phone: String,
    avatar: String,
    linkedinUrl: String,
    linkedinId: { type: String, sparse: true, unique: true }, // Unique index on LinkedIn ID
    extraLinks: [String],
    uploadedBy: String,
  },
  { timestamps: { createdAt: 'uploadedAt', updatedAt: 'updatedAt' } }
);

// Pre-save middleware to extract and set LinkedIn ID
profileSchema.pre('save', function(next) {
  if (this.linkedinUrl) {
    this.linkedinId = extractLinkedInId(this.linkedinUrl);
  }
  next();
});

module.exports = mongoose.model('Profile', profileSchema);