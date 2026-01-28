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

// GET all users with dashboard stats
router.get("/users", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({}).select(
      "name email updatedAt isAdmin isSuperAdmin",
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
        joinedAt: user.updatedAt,
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

// GET platform statistics
router.get("/stats", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalContacts = await Profile.countDocuments();
    const totalDashboards = await Dashboard.countDocuments();

    // Get total points distributed
    const dashboards = await Dashboard.find({});
    const totalPoints = dashboards.reduce(
      (sum, dashboard) => sum + dashboard.availablePoints,
      0,
    );

    // Get active users this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const activeUsersThisMonth = await User.countDocuments({
      createdAt: { $gte: startOfMonth },
    });

    res.json({
      totalUsers,
      totalContacts,
      totalPointsDistributed: totalPoints,
      activeUsersThisMonth,
      totalDashboards,
    });
  } catch (err) {
    console.error("Admin stats fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

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
                unlockedProfiles: -1, // Remove from unlocked count
                totalContacts: -1, // Also reduce total contacts
              },
              $pull: {
                unlockedProfileIds: contactId, // Remove from unlocked IDs
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
                uploadedProfiles: -1, // Remove from uploaded count
                totalContacts: -1, // Also reduce total contacts
              },
              $pull: {
                uploadedProfileIds: contactId, // Remove from uploaded IDs
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
        createdAt: u.createdAt,
      })),
      contacts: contacts.map((c) => ({
        id: c._id,
        name: c.name,
        jobTitle: c.jobTitle,
        company: c.company,
        email: c.email,
        phone: c.phone,
        uploadedBy: c.uploadedBy,
        uploadedAt: c.uploadedAt,
      })),
      dashboards: dashboards.map((d) => ({
        userId: d.userId,
        availablePoints: d.availablePoints,
        totalContacts: d.totalContacts,
        uploadedProfiles: d.uploadedProfiles,
        unlockedProfiles: d.unlockedProfiles,
      })),
    };

    res.json(exportData);
  } catch (err) {
    console.error("Export data error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
