const express = require("express");
const User = require("../models/User");
const Dashboard = require("../models/Dashboard");
const Profile = require("../models/profile");
const { authMiddleware } = require("./auth");

const router = express.Router();

// Admin middleware
const adminMiddleware = (req, res, next) => {
  if (!req?.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

// Super Admin middleware - only super admins can access
const superAdminMiddleware = (req, res, next) => {
  if (!req?.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
};

// Function to extract LinkedIn identifier from URL
function extractLinkedInId(url) {
  if (!url) return null;
  // Match the pattern: linkedin.com/in/USERNAME
  const match = url.match(/linkedin\.com\/in\/([^/?]+)/);
  return match ? match[1].toLowerCase() : null;
}

// GET all users with dashboard stats
router.get("/users", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({}).select(
      "name email uploadedAt isAdmin isSuperAdmin isVerified",
    );

    // Get dashboards for all users
    const userIds = users.map((user) => user._id);
    const dashboards = await Dashboard.find({ userId: { $in: userIds } });

    const usersWithStats = users.map((user) => {
      const dashboard = dashboards.find(
        (d) => d.userId.toString() === user._id.toString(),
      );
      return {
        id: user._id,
        name: user.name || user.email,
        email: user.email,
        isAdmin: user.isAdmin,
        isSuperAdmin: user.isSuperAdmin,
        joinedAt: user.uploadedAt,
        isVerified: user.isVerified,
        points: dashboard?.availablePoints || 0,
        uploads: dashboard?.uploadedProfiles || 0,
        unlocks: dashboard?.unlockedProfiles || 0,
      };
    });
    res.json(usersWithStats);
  } catch (err) {
    console.error("Admin users fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST toggle admin status
router.post(
  "/users/:id/toggle-admin",
  authMiddleware,
  adminMiddleware,
  superAdminMiddleware,
  async (req, res) => {
    try {
      const userId = req.params.id;

      if (userId.toString() === req.userId.toString()) {
        return res
          .status(400)
          .json({ error: "Cannot change your own admin status" });
      }

      const user = await User.findById(userId.toString());
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Toggle admin status
      user.isAdmin = !user.isAdmin;
      await user.save();

      res.json({
        success: true,
        message: `User ${user.isAdmin ? "promoted to" : "removed from"} admin successfully`,
        userId: user._id,
        isAdmin: user.isAdmin,
      });
    } catch (err) {
      console.error("Toggle admin status error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// GET all contacts with uploader info
router.get("/contacts", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const contacts = await Profile.find({}).sort({ uploadedAt: -1 });

    const contactsWithUploader = await Promise.all(
      contacts.map(async (contact) => {
        let uploaderName = "Unknown";
        if (contact.uploadedBy) {
          const uploader = await User.findById(contact.uploadedBy).select(
            "name email",
          );
          uploaderName = uploader?.name || uploader?.email || "Unknown";
        }

        return {
          id: contact._id,
          name: contact.name,
          jobTitle: contact.jobTitle,
          company: contact.company,
          location: contact.location,
          industry: contact.industry,
          experience: contact.experience,
          seniorityLevel: contact.seniorityLevel,
          skills: contact.skills,
          education: contact.education,
          workExperience: contact.workExperience,
          email: contact.email,
          phone: contact.phone,
          avatar: contact.avatar,
          linkedinUrl: contact.linkedinUrl,
          linkedinId: contact.linkedinId,
          extraLinks: contact.extraLinks,
          uploadedBy: contact.uploadedBy,
          uploadedAt: contact.uploadedAt,
          uploaderName,
        };
      }),
    );

    res.json(contactsWithUploader);
  } catch (err) {
    console.error("Admin contacts fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET recent admin activities
router.get(
  "/recent-activities",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      // Get last 5 user registrations
      const recentUsers = await User.find()
        .sort({ uploadedAt: -1 })
        .limit(5)
        .select("name email uploadedAt");

      // Get last 5 contact uploads
      const recentContacts = await Profile.find()
        .sort({ uploadedAt: -1 })
        .limit(5)
        .select("name uploadedBy uploadedAt");

      // Combine and sort activities
      const activities = [
        ...recentUsers.map((user) => ({
          message: `New user registered: ${user.email}`,
          timestamp: user.uploadedAt,
          type: "user",
        })),
        ...recentContacts.map((contact) => ({
          message: `Contact uploaded: ${contact.name}`,
          timestamp: contact.uploadedAt,
          type: "contact",
        })),
      ]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 10)
        .map((activity) => ({
          message: activity.message,
          timestamp: new Date(activity.timestamp).toLocaleDateString(),
        }));

      res.json(activities);
    } catch (err) {
      console.error("Admin activities fetch error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// Delete user (with cascade delete)
router.delete(
  "/users/:id",
  authMiddleware,
  adminMiddleware,
  superAdminMiddleware,
  async (req, res) => {
    try {
      const userId = req.params.id;

      if (userId.toString() === req.userId.toString()) {
        return res
          .status(400)
          .json({ error: "Cannot delete your own account" });
      }

      // Delete user's dashboard only
      await Dashboard.findOneAndDelete({ userId });

      // Delete the user
      await User.findByIdAndDelete(userId);

      res.json({ success: true, message: "User deleted successfully" });
    } catch (err) {
      console.error("Delete user error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// DELETE contact with full cleanup and point adjustments
router.delete(
  "/contacts/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const contactId = req.params.id;

      // 1. Get the contact to be deleted
      const contact = await Profile.findById(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }

      // 2. Get all dashboards that have this contact in unlockedProfileIds
      const dashboardsWithUnlocked = await Dashboard.find({
        unlockedProfileIds: { $in: [contactId] },
      });

      // 3. Get the uploader's dashboard (if exists)
      let uploaderDashboard = null;
      if (contact.uploadedBy) {
        uploaderDashboard = await Dashboard.findOne({
          userId: contact.uploadedBy,
        });
      }

      // 4. Update all affected dashboards
      const updatePromises = [];

      // 4a. Update dashboards of users who unlocked this contact (+20 points each)
      for (const dashboard of dashboardsWithUnlocked) {
        updatePromises.push(
          Dashboard.findByIdAndUpdate(
            dashboard._id,
            {
              $inc: {
                availablePoints: 20,
                unlockedProfiles: -1,
                totalContacts: -1,
              },
              $pull: {
                unlockedProfileIds: contactId,
              },
              $push: {
                recentActivity: {
                  $each: [
                    `Refunded 20 points: Contact "${contact.name || "Unknown"}" was deleted by admin`,
                  ],
                  $slice: -20,
                },
              },
              updatedAt: new Date(),
            },
            { new: true },
          ),
        );
      }

      // 4b. Update uploader's dashboard (-10 points)
      if (uploaderDashboard) {
        updatePromises.push(
          Dashboard.findByIdAndUpdate(
            uploaderDashboard._id,
            {
              $inc: {
                availablePoints: -10,
                uploadedProfiles: -1,
                totalContacts: -1,
              },
              $pull: {
                uploadedProfileIds: contactId,
              },
              $push: {
                recentActivity: {
                  $each: [
                    `Deducted 10 points: Your contact "${contact.name || "Unknown"}" was deleted by admin`,
                  ],
                  $slice: -20,
                },
              },
              updatedAt: new Date(),
            },
            { new: true },
          ),
        );
      }

      // 5. Execute all updates
      await Promise.all(updatePromises);

      // 6. Delete the contact
      await Profile.findByIdAndDelete(contactId);

      res.json({
        success: true,
        message: "Contact deleted successfully",
        refundedUsersCount: dashboardsWithUnlocked.length,
        deductedFromUploader: !!uploaderDashboard,
      });
    } catch (err) {
      console.error("Delete contact error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// Export all data as JSON
router.get("/export", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({});
    const contacts = await Profile.find({});
    const dashboards = await Dashboard.find({});

    const exportData = {
      exportedAt: new Date(),
      users: users.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email,
        isAdmin: u.isAdmin,
        googleId: u.googleId,
        superAdmin: u.isSuperAdmin,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        verified: u.isVerified,
      })),
      contacts: contacts.map((c) => ({
        id: c._id,
        name: c.name,
        jobTitle: c.jobTitle,
        company: c.company,
        location: c.location,
        industry: c.industry,
        experience: c.experience,
        seniorityLevel: c.seniorityLevel,
        skills: c.skills,
        education: c.education,
        workExperience: c.workExperience,
        email: c.email,
        phone: c.phone,
        avatar: c.avatar,
        linkedinUrl: c.linkedinUrl,
        linkedinId: c.linkedinId,
        extraLinks: c.extraLinks,
        uploadedBy: c.uploadedBy,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      dashboards: dashboards.map((d) => ({
        userId: d.userId,
        availablePoints: d.availablePoints,
        totalContacts: d.totalContacts,
        uploadedProfiles: d.uploadedProfiles,
        unlockedProfiles: d.unlockedProfiles,
        recentActivity: d.recentActivity,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
    };

    res.json(exportData);
  } catch (err) {
    console.error("Export data error:", err);
    res.status(500).json({ error: err.message });
  }
});

function transformImportedContact(contact) {
  const newContact = {};

  for (let key in contact) {
    newContact[key.toLowerCase()] = contact[key];
  }
  // Ensure arrays
  const email = Array.isArray(newContact.email)
    ? newContact.email.filter((e) => e && e.trim())
    : newContact.email
      ? [newContact.email].filter((e) => e && e.trim())
      : [];

  const phone = Array.isArray(newContact.phone)
    ? newContact.phone.filter((p) => p && p.trim())
    : newContact.phone
      ? [newContact.phone].filter((p) => p && p.trim())
      : [];

  const skills = Array.isArray(newContact.skills)
    ? newContact.skills.filter((s) => s && s.trim())
    : newContact.skills
      ? [newContact.skills].filter((s) => s && s.trim())
      : [];

  const extraLinks = Array.isArray(newContact.extralinks)
    ? newContact.extralinks.filter((l) => l && l.trim())
    : newContact.extralinks
      ? [newContact.extralinks].filter((l) => l && l.trim())
      : [];

  const linkedinUrl = newContact.linkedinurl || "";
  const linkedinId = extractLinkedInId(linkedinUrl.trim());

  return {
    name: newContact.name || linkedinId || "",
    jobTitle: newContact.jobtitle || "",
    company: newContact.company || "",
    location: newContact.location || "",
    industry: newContact.industry || "Other",
    experience: newContact.experience || 0,
    seniorityLevel: newContact.senioritylevel || "Mid-level",
    skills: skills || [],
    education: newContact.education || "",
    workExperience: newContact.workexperience || "",
    email: email || [],
    phone: phone || [],
    avatar:
      newContact.avatar ||
      "https://images.pexels.com/photos/771742/pexels-photo-771742.jpeg?auto=compress&cs=tinysrgb&w=150&h=150&fit=crop",
    linkedinUrl: newContact.linkedinurl || "",
    linkedinId: linkedinId || "",
    extraLinks: extraLinks || [],
  };
}

router.post(
  "/import-contacts",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { contacts } = req.body;
      const userId = req?.userId;

      const results = {
        total: contacts.length,
        successful: 0,
        failed: 0,
        errors: [],
      };

      for (const contact of contacts) {
        try {
          // Transform imported contact
          const transformedContact = transformImportedContact(contact);

          // Validate
          if (
            !transformedContact.linkedinUrl ||
            (!transformedContact.email.length &&
              !transformedContact.phone.length)
          ) {
            throw new Error(
              "Contact must have linkedinUrl and at least one Email or Phone",
            );
          }

          // Check existing
          const existingContact = await Profile.findOne({
            linkedinId: transformedContact.linkedinId,
          });

          if (existingContact) {
            // Update existing
            const updateData = {
              ...transformedContact,
              uploadedBy: userId,
              updatedAt: new Date(),
            };

            // Merge arrays
            if (transformedContact.email.length) {
              updateData.email = [
                ...new Set([
                  ...existingContact.email,
                  ...transformedContact.email,
                ]),
              ];
            }
            if (transformedContact.phone.length) {
              updateData.phone = [
                ...new Set([
                  ...existingContact.phone,
                  ...transformedContact.phone,
                ]),
              ];
            }
            if (transformedContact.skills.length) {
              updateData.skills = [
                ...new Set([
                  ...existingContact.skills,
                  ...transformedContact.skills,
                ]),
              ];
            }
            if (transformedContact.extraLinks.length) {
              updateData.extraLinks = [
                ...new Set([
                  ...existingContact.extraLinks,
                  ...transformedContact.extraLinks,
                ]),
              ];
            }

            await Profile.findByIdAndUpdate(existingContact._id, updateData);
          } else {
            // Create new
            const newContact = new Profile({
              ...transformedContact,
              uploadedBy: userId,
            });
            await newContact.save();

            const pointsEarned = 10;
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
                      `Uploaded LinkedIn profile: ${transformedContact.name || "Unknown"}`,
                    ],
                    $slice: -20,
                  },
                },
                $addToSet: {
                  uploadedProfileIds: newContact._id,
                },
                updatedAt: new Date(),
              },
            );
          }

          results.successful++;
        } catch (error) {
          results.failed++;
          results.errors.push(
            `Contact ${results.total - results.failed}: ${error.message}`,
          );
        }
      }

      res.json({ success: true, results });
    } catch (error) {
      console.error("Import contacts error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

module.exports = router;
