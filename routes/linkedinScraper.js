const express = require("express");
const crypto = require("crypto");
const Profile = require("../models/profile");
const Dashboard = require("../models/Dashboard");
const { extractLinkedInId } = require("../utils/linkedinHelper");
const cloudinary = require("cloudinary").v2;

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

router.post("/scrape-linkedin", async (req, res) => {
  try {
    const { profilesData, userId } = req.body;

    // Validate input
    if (
      !profilesData ||
      !Array.isArray(profilesData) ||
      profilesData.length === 0
    ) {
      return res.status(400).json({ error: "ProfilesData is required" });
    }

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    // Validate and structure profile data
    const validProfiles = profilesData
      .filter(
        (profile) =>
          profile.url &&
          (profile.url.includes("linkedin.com/in/") ||
            profile.url.includes("linkedin.com/pub/")),
      )
      .map((profile) => ({
        url: profile.url.trim(),
        phone: (profile.phone || "").trim(),
        email: (profile.email || "").trim(),
        extraLinks: Array.isArray(profile.extraLinks)
          ? profile.extraLinks.filter(Boolean)
          : [],
      }));

    if (validProfiles.length === 0) {
      return res.status(400).json({ error: "No valid LinkedIn URLs found" });
    }

    if (
      validProfiles.length > 0 &&
      validProfiles.every((p) => !p.phone && !p.email)
    ) {
      return res.status(400).json({
        error: "You must add phone or email to uploading or updating a profile",
      });
    }

    // Check which profiles already exist in database
    const profilesToScrape = [];
    const profilesToUpdate = [];

    for (const profile of validProfiles) {
      const linkedinId = extractLinkedInId(profile.url);
      if (linkedinId) {
        const existingProfile = await Profile.findOne({ linkedinId });
        if (existingProfile) {
          // Profile exists - check ownership
          if (existingProfile.uploadedBy.toString() !== userId.toString()) {
            return res.status(403).json({
              error: "You cannot update a profile you didn't upload",
              url: profile.url,
            });
          }
          profilesToUpdate.push({ profile, existingProfile });
        } else {
          profilesToScrape.push(profile);
        }
      } else {
        profilesToScrape.push(profile);
      }
    }

    const results = {
      total: validProfiles.length,
      processed: 0,
      successful: 0,
      failed: 0,
      results: [],
    };

    // Process profiles that need scraping
    if (profilesToScrape.length > 0) {
      const apiToken = process.env.APIFY_API_KEY;
      if (!apiToken) {
        return res
          .status(500)
          .json({ error: "LinkedIn scraping service not configured" });
      }

      // Start scraping
      const urls = profilesToScrape.map((profile) => ({ url: profile.url }));
      const runResponse = await fetch(
        `https://api.apify.com/v2/acts/supreme_coder~linkedin-profile-scraper/runs?token=${apiToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls }),
        },
      );

      if (!runResponse.ok) {
        throw new Error("Failed to start scraping");
      }

      const runData = await runResponse.json();
      const runId = runData.data.id;

      // Poll for completion
      let runStatus = "RUNNING";
      let attempts = 0;
      const maxAttempts = 60;

      while (runStatus === "RUNNING" && attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const statusResponse = await fetch(
          `https://api.apify.com/v2/acts/supreme_coder~linkedin-profile-scraper/runs/${runId}?token=${apiToken}`,
        );
        const statusData = await statusResponse.json();
        runStatus = statusData.data.status;
        attempts++;
      }

      if (runStatus !== "SUCCEEDED") {
        throw new Error(`Scraping failed with status: ${runStatus}`);
      }

      // Get scraped data
      const datasetId = runData.data.defaultDatasetId;
      const itemsResponse = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiToken}`,
      );
      const scrapedData = await itemsResponse.json();

      if (scrapedData.length === 0) {
        return res.status(429).json({
          error: "Free limit exceeded. Please upgrade your Apify plan",
          message:
            "You've reached the free limit Or there is an error in scraping process",
        });
      }

      // Process scraped profiles
      for (let i = 0; i < profilesToScrape.length; i++) {
        const profileInput = profilesToScrape[i];
        const profileData = scrapedData[i];

        try {
          results.processed++;

          if (!profileData) {
            throw new Error("No profile data received");
          }

          const contactData = transformLinkedInDataWithPhone(
            profileData,
            profileInput,
          );

          // Check minimum data
          const hasMinimumData =
            contactData.name &&
            (contactData.experience > 0 ||
              contactData.company ||
              contactData.jobTitle);

          if (!hasMinimumData) {
            throw new Error("profile does not have enough data to be saved");
          }

          // Create new profile
          contactData.uploadedBy = userId;
          const savedContact = await Profile.create(contactData);

          if (profileData.pictureUrl || profileData.profilePicture) {
            try {
              const avatarUrl =
                profileData.pictureUrl || profileData.profilePicture;
              const publicId = crypto
                .createHash("sha256")
                .update(avatarUrl)
                .digest("hex");

              let imageUrl;
              try {
                const existing = await cloudinary.api.resource(
                  `avatars/${publicId}`,
                );
                imageUrl = existing.secure_url;
              } catch (e) {
                const result = await cloudinary.uploader.upload(avatarUrl, {
                  folder: "avatars",
                  public_id: publicId,
                  overwrite: false,
                  invalidate: false,
                });
                imageUrl = result.secure_url;
              }

              await Profile.findByIdAndUpdate(savedContact._id, {
                avatar: imageUrl,
              });
              console.log("Avatar uploaded successfully:", imageUrl);
            } catch (error) {
              console.error("Avatar upload failed:", error);
            }
          }

          const pointsEarned = 10;
          const profileId = savedContact._id.toString();

          // Update dashboard
          await Dashboard.findOneAndUpdate(
            { userId },
            {
              $inc: {
                availablePoints: pointsEarned,
                totalContacts: 1,
                uploadedProfiles: 1,
              },
              $push: {
                recentActivity: {
                  $each: [
                    `Uploaded LinkedIn profile: ${contactData.name || "Unknown"}`,
                  ],
                  $slice: -20,
                },
              },
              $addToSet: {
                uploadedProfileIds: profileId,
              },
              updatedAt: new Date(),
            },
            { upsert: true },
          );

          results.successful++;
          results.results.push({
            url: profileInput.url,
            status: "success",
            pointsEarned,
            data: {
              name: contactData.name,
              jobTitle: contactData.jobTitle,
              company: contactData.company,
            },
          });
        } catch (error) {
          results.failed++;
          results.results.push({
            url: profileInput.url,
            status: "failed",
            error: error.message,
          });
        }
      }
    }

    // Process profiles that need updating (no scraping)
    for (const { profile, existingProfile } of profilesToUpdate) {
      try {
        results.processed++;
        let hasChanges = [];
        let errors = [];

        if (profile.phone && profile.phone.trim() !== "") {
          const newPhone = profile.phone.trim();
          const existingPhones = Array.isArray(existingProfile.phone)
            ? existingProfile.phone
            : existingProfile.phone
              ? [existingProfile.phone]
              : [];

          if (existingPhones.includes(newPhone)) {
            errors.push(`Phone (${newPhone}) already exists`);
          } else {
            existingPhones.push(newPhone);
            existingProfile.phone = existingPhones;
            hasChanges.push("phone");
          }
        }

        if (profile.email && profile.email.trim() !== "") {
          const newEmail = profile.email.trim();
          const existingEmails = Array.isArray(existingProfile.email)
            ? existingProfile.email
            : existingProfile.email
              ? [existingProfile.email]
              : [];

          if (existingEmails.includes(newEmail)) {
            errors.push(`Email (${newEmail}) already exists`);
          } else {
            existingEmails.push(newEmail);
            existingProfile.email = existingEmails;
            hasChanges.push("email");
          }
        }

        if (profile.extraLinks && profile.extraLinks.length > 0) {
          const existingLinks = Array.isArray(existingProfile.extraLinks)
            ? existingProfile.extraLinks
            : existingProfile.extraLinks
              ? [existingProfile.extraLinks]
              : [];

          const uniqueInputLinks = [
            ...new Set(profile.extraLinks.map((link) => link.trim())),
          ].filter((link) => link);

          const newLinks = uniqueInputLinks.filter(
            (link) => !existingLinks.includes(link),
          );
          const oldLinks = uniqueInputLinks.filter((link) =>
            existingLinks.includes(link),
          );

          if (newLinks.length > 0) {
            existingProfile.extraLinks = [...existingLinks, ...newLinks];
            hasChanges.push("extra links");
          }

          if (oldLinks.length > 0) {
            errors.push(
              `Extra link(s) : ${oldLinks.join(" , ")} already exists`,
            );
          }
        }

        if (hasChanges.length > 0 && errors.length > 0) {
          await existingProfile.save();

          const pointsEarned = 5;
          await Dashboard.findOneAndUpdate(
            { userId },
            {
              $inc: { availablePoints: pointsEarned },
              $push: {
                recentActivity: {
                  $each: [
                    `Updated LinkedIn profile: ${existingProfile.name || "Unknown"}`,
                  ],
                  $slice: -20,
                },
              },
              updatedAt: new Date(),
            },
            { upsert: true },
          );

          const ChangesMessage = `Updated : ${hasChanges.join(", ")}`;
          const errorsMessage = `But : ${errors.join(" || ")}`;

          results.successful++;
          results.results.push({
            url: profile.url,
            status: "warning",
            warning: `${ChangesMessage} / ${errorsMessage}`,
          });
        } else if (errors.length > 0) {
          results.failed++;
          results.results.push({
            url: profile.url,
            status: "failed",
            error: errors.join(" || "),
          });
        } else if (hasChanges.length > 0) {
          await existingProfile.save();

          const pointsEarned = 5;
          await Dashboard.findOneAndUpdate(
            { userId },
            {
              $inc: { availablePoints: pointsEarned },
              $push: {
                recentActivity: {
                  $each: [
                    `Updated LinkedIn profile: ${existingProfile.name || "Unknown"}`,
                  ],
                  $slice: -20,
                },
              },
              updatedAt: new Date(),
            },
            { upsert: true },
          );

          results.successful++;
          results.results.push({
            url: profile.url,
            status: "success",
            pointsEarned,
            data: {
              name: existingProfile.name,
              jobTitle: existingProfile.jobTitle,
              company: existingProfile.company,
            },
          });
        }
      } catch (error) {
        results.failed++;
        results.results.push({
          url: profile.url,
          status: "failed",
          error: error.message,
        });
      }
    }

    res.json({
      success: true,
      results,
      totalPointsEarned: results.results
        .filter((r) => r.status === "success")
        .reduce((sum, r) => sum + r.pointsEarned, 0),
    });
  } catch (error) {
    console.error("Scraping error:", error);
    res
      .status(500)
      .json({ error: "Internal server error", message: error.message });
  }
});

// Updated helper function to transform LinkedIn data with user-provided phone info only
function transformLinkedInDataWithPhone(linkedInProfile, profileInput) {
  if (!linkedInProfile) {
    throw new Error("No profile data received");
  }

  // Extract work experience description from positions array
  let workExperience = "";
  if (linkedInProfile.positions && linkedInProfile.positions.length > 0) {
    workExperience = linkedInProfile.positions
      .map((position) => {
        const title = position.title || "";
        const company = position.companyName || position.company?.name || "";
        const description = position.description || "";
        const location = position.locationName || "";

        // Format date range
        let dateRange = "";
        if (position.timePeriod) {
          const start = position.timePeriod.startDate;
          const end = position.timePeriod.endDate;

          if (start) {
            const startMonth = start.month
              ? String(start.month).padStart(2, "0")
              : "";
            const startYear = start.year || "";
            const startStr =
              startMonth && startYear
                ? `${startMonth}/${startYear}`
                : startYear;

            let endStr = "Present";
            if (end) {
              const endMonth = end.month
                ? String(end.month).padStart(2, "0")
                : "";
              const endYear = end.year || "";
              endStr = endMonth && endYear ? `${endMonth}/${endYear}` : endYear;
            }

            dateRange = ` (${startStr} - ${endStr})`;
          }
        }

        let experienceText = `${title} at ${company}${dateRange}`;
        if (location) {
          experienceText += ` - ${location}`;
        }

        if (description) {
          experienceText += `\n${description}`;
        }

        return experienceText;
      })
      .join("\n\n---\n\n");
  }

  // Extract skills from multiple sources: skills array, courses, and certifications
  let skills = [];

  // Primary skills from skills array
  if (linkedInProfile.skills && Array.isArray(linkedInProfile.skills)) {
    const primarySkills = linkedInProfile.skills
      .map((skill) =>
        typeof skill === "string" ? skill : skill.name || skill.title || "",
      )
      .filter((skill) => skill.trim());
    skills.push(...primarySkills);
  }

  // Additional skills from courses
  if (linkedInProfile.courses && Array.isArray(linkedInProfile.courses)) {
    const courseSkills = linkedInProfile.courses
      .map((course) =>
        typeof course === "string" ? course : course.name || course.title || "",
      )
      .filter((skill) => skill.trim());
    skills.push(...courseSkills);
  }

  // Additional skills from certifications
  if (
    linkedInProfile.certifications &&
    Array.isArray(linkedInProfile.certifications)
  ) {
    const certificationSkills = linkedInProfile.certifications
      .map((cert) =>
        typeof cert === "string" ? cert : cert.name || cert.title || "",
      )
      .filter((skill) => skill.trim())
      .slice(0, 10); // Limit certifications to avoid too many skills
    skills.push(...certificationSkills);
  }

  // Remove duplicates and limit total skills
  skills = [...new Set(skills)].slice(0, 25); // Remove duplicates and limit to 25 skills

  // Extract education from educations array
  let education = "";
  if (linkedInProfile.educations && linkedInProfile.educations.length > 0) {
    education = linkedInProfile.educations
      .map((edu) => {
        const degree = edu.degreeName || "";
        const field = edu.fieldOfStudy || "";
        const school = edu.schoolName || "";

        let educationText = "";
        if (degree && field) {
          educationText = `${degree} in ${field}`;
        } else if (degree) {
          educationText = degree;
        } else if (field) {
          educationText = field;
        }

        if (school) {
          educationText += educationText ? ` at ${school}` : school;
        }

        // Add time period if available
        if (edu.timePeriod) {
          const start = edu.timePeriod.startDate?.year;
          const end = edu.timePeriod.endDate?.year;
          if (start || end) {
            const timeStr =
              start && end ? `${start}-${end}` : start ? `${start}` : `${end}`;
            educationText += ` (${timeStr})`;
          }
        }

        return educationText;
      })
      .filter((edu) => edu.trim())
      .join("; ");
  }

  // Determine industry from profile data or positions
  let industry = linkedInProfile.industryName || "Other";
  if (!industry || industry === "Other") {
    if (linkedInProfile.positions && linkedInProfile.positions.length > 0) {
      const currentPosition = linkedInProfile.positions[0];
      if (
        currentPosition.company?.industries &&
        currentPosition.company.industries.length > 0
      ) {
        industry = currentPosition.company.industries[0];
      }
    }
  }

  // Calculate total experience years based on all positions
  let experienceYears = 0;
  if (linkedInProfile.positions && linkedInProfile.positions.length > 0) {
    // Find the earliest start date across all positions
    let earliestStartYear = null;

    linkedInProfile.positions.forEach((position) => {
      if (
        position.timePeriod &&
        position.timePeriod.startDate &&
        position.timePeriod.startDate.year
      ) {
        if (
          !earliestStartYear ||
          position.timePeriod.startDate.year < earliestStartYear
        ) {
          earliestStartYear = position.timePeriod.startDate.year;
        }
      }
    });

    if (earliestStartYear) {
      const currentYear = new Date().getFullYear();
      experienceYears = Math.max(0, currentYear - earliestStartYear);
    }
  }

  // Determine seniority level based on job title and experience
  const jobTitle =
    linkedInProfile.jobTitle ||
    linkedInProfile.occupation ||
    linkedInProfile.positions?.[0]?.title ||
    "";
  let seniorityLevel = "Mid-level";
  const titleLower = jobTitle.toLowerCase();

  if (
    titleLower.includes("ceo") ||
    titleLower.includes("cto") ||
    titleLower.includes("cfo") ||
    titleLower.includes("chief")
  ) {
    seniorityLevel = "C-Level";
  } else if (
    titleLower.includes("vp") ||
    titleLower.includes("vice president")
  ) {
    seniorityLevel = "VP";
  } else if (
    titleLower.includes("director") ||
    titleLower.includes("manager")
  ) {
    seniorityLevel = "Director";
  } else if (
    titleLower.includes("senior") ||
    titleLower.includes("lead") ||
    titleLower.includes("principal")
  ) {
    seniorityLevel = "Senior";
  } else if (titleLower.includes("junior") || experienceYears < 2) {
    seniorityLevel = "Entry-level";
  }

  // Extract company size
  let companySize = "";
  if (linkedInProfile.positions && linkedInProfile.positions.length > 0) {
    const currentPosition = linkedInProfile.positions[0];
    if (currentPosition.company?.employeeCountRange) {
      const range = currentPosition.company.employeeCountRange;
      companySize = `${range.start}-${range.end} employees`;
    }
  }

  // Get location from profile or current position
  const location =
    linkedInProfile.geoLocationName ||
    linkedInProfile.geoCountryName ||
    linkedInProfile.positions?.[0]?.locationName ||
    "";

  const finalEmail = Array.isArray(profileInput.email)
    ? profileInput.email.filter((email) => email && email.trim() !== "")
    : profileInput.email && profileInput.email.trim() !== ""
      ? [profileInput.email.trim()]
      : [];

  const finalPhone = Array.isArray(profileInput.phone)
    ? profileInput.phone.filter((phone) => phone && phone.trim() !== "")
    : profileInput.phone && profileInput.phone.trim() !== ""
      ? [profileInput.phone.trim()]
      : [];

  const finalExtraLinks = Array.isArray(profileInput.extraLinks)
    ? profileInput.extraLinks.filter((link) => link && link.trim() !== "")
    : [];

  return {
    name:
      `${linkedInProfile.firstName || ""} ${linkedInProfile.lastName || ""}`.trim() ||
      linkedInProfile.fullName ||
      "",
    jobTitle,
    company:
      linkedInProfile.companyName ||
      linkedInProfile.positions?.[0]?.companyName ||
      "",
    location,
    industry,
    experience: experienceYears,
    seniorityLevel,
    skills,
    education,
    workExperience,
    email: finalEmail || linkedInProfile.email || [],
    phone: finalPhone || [],
    avatar:
      linkedInProfile.pictureUrl ||
      linkedInProfile.profilePicture ||
      "https://images.pexels.com/photos/771742/pexels-photo-771742.jpeg?auto=compress&cs=tinysrgb&w=150&h=150&fit=crop",
    companySize,
    linkedinUrl:
      linkedInProfile.inputUrl ||
      linkedInProfile.url ||
      linkedInProfile.linkedinUrl ||
      profileInput.url,
    extraLinks: finalExtraLinks || [],
  };
}

module.exports = router;
