// routes/linkedinScraper.js - Updated to handle phone information only
const express = require('express');
const router = express.Router();

// LinkedIn scraping endpoint
router.post('/scrape-linkedin', async (req, res) => {
  try {
    const { profilesData, userId } = req.body;

    // Validate input
    if (!profilesData || !Array.isArray(profilesData) || profilesData.length === 0) {
      return res.status(400).json({ 
        error: 'ProfilesData array is required and cannot be empty' 
      });
    }

    if (!userId) {
      return res.status(400).json({ 
        error: 'User ID is required' 
      });
    }

    // Validate and structure profile data
    const validProfiles = profilesData.filter(profile => 
      profile.url && (profile.url.includes('linkedin.com/in/') || profile.url.includes('linkedin.com/pub/'))
    ).map(profile => ({
      url: profile.url.trim(),
      phone: (profile.phone || '').trim(),
      email: (profile.email || '').trim(),
      extraLinks: Array.isArray(profile.extraLinks) ? profile.extraLinks.filter(Boolean) : []
    }));

    if (validProfiles.length === 0) {
      return res.status(400).json({ 
        error: 'No valid LinkedIn URLs found' 
      });
    }

    const apiToken = process.env.APIFY_API_KEY;
    
    if (!apiToken) {
      return res.status(500).json({ 
        error: 'LinkedIn scraping service not configured' 
      });
    }

    // Initialize results tracking
    const results = {
      total: validProfiles.length,
      processed: 0,
      successful: 0,
      failed: 0,
      results: []
    };

    console.log(`Starting LinkedIn scraping for ${validProfiles.length} profiles with phone info`);

    try {
      // Start the Apify actor run with just URLs
      const urls = validProfiles.map(profile => ({ url: profile.url }));
      
      const runResponse = await fetch(`https://api.apify.com/v2/acts/supreme_coder~linkedin-profile-scraper/runs?token=${apiToken}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          urls: urls,
          "findContacts.contactCompassToken": ""
        })
      });

      if (!runResponse.ok) {
        const errorText = await runResponse.text();
        console.error('Apify run failed:', runResponse.status, errorText);
        throw new Error(`LinkedIn scraping service failed: ${runResponse.status}`);
      }

      const runData = await runResponse.json();
      const runId = runData.data.id;

      console.log(`Apify run started with ID: ${runId}`);

      // Poll for completion
      let runStatus = 'RUNNING';
      let attempts = 0;
      const maxAttempts = 60; // 3 minutes max wait time

      while (runStatus === 'RUNNING' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
        
        const statusResponse = await fetch(`https://api.apify.com/v2/acts/supreme_coder~linkedin-profile-scraper/runs/${runId}?token=${apiToken}`);
        
        if (!statusResponse.ok) {
          throw new Error('Failed to check scraping status');
        }

        const statusData = await statusResponse.json();
        runStatus = statusData.data.status;
        attempts++;

        console.log(`Scraping status: ${runStatus} (attempt ${attempts})`);
      }

      if (runStatus !== 'SUCCEEDED') {
        throw new Error(`Scraping failed with status: ${runStatus}`);
      }

      // Get the scraped data
      const datasetId = runData.data.defaultDatasetId;
      const itemsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiToken}`);
      
      if (!itemsResponse.ok) {
        throw new Error(`Failed to fetch scraping results: ${itemsResponse.status}`);
      }

      const scrapedData = await itemsResponse.json();
      console.log(`Received ${scrapedData.length} scraped profiles`);

      // Process each scraped profile with the provided contact info
      for (let i = 0; i < validProfiles.length; i++) {
        const profileInput = validProfiles[i];
        const profileData = scrapedData[i];

        try {
          results.processed++;

          if (!profileData) {
            throw new Error('No profile data received');
          }

          // Transform LinkedIn data to our contact format, including user-provided phone info
          const contactData = transformLinkedInDataWithPhone(profileData, userId, profileInput);

          // Check if profile has sufficient data
          const hasMinimumData = contactData.name && // Has a name
                                (contactData.experience > 0 || // Has experience
                                 contactData.company || // Or has a company
                                 contactData.jobTitle); // Or has a job title

          if (!hasMinimumData) {
            console.log('Profile skipped due to insufficient data:', {
              url: profileInput.url,
              name: contactData.name,
              experience: contactData.experience,
              company: contactData.company,
              jobTitle: contactData.jobTitle
            });
            throw new Error('Insufficient profile data - profile must have a name and either experience, company, or job title');
          }

          // Save contact using the existing profiles API endpoint
          const saveResponse = await fetch(`${process.env.BASE_URL || 'https://contactpro-backend.vercel.app'}/profiles`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(contactData)
          });

          if (!saveResponse.ok) {
            const errorData = await saveResponse.json().catch(() => ({}));
            throw new Error(errorData.message || `Failed to save contact: ${saveResponse.status}`);
          }

          const savedContact = await saveResponse.json();

          results.successful++;
          results.results.push({ 
            url: profileInput.url, 
            status: 'success', 
            data: {
              name: contactData.name,
              jobTitle: contactData.jobTitle,
              company: contactData.company,
              phone: contactData.phone
            }
          });

          console.log(`Successfully processed profile: ${contactData.name}`);

        } catch (error) {
          console.error(`Error processing ${profileInput.url}:`, error);
          results.failed++;
          results.results.push({ 
            url: profileInput.url, 
            status: 'failed', 
            error: error.message
          });
        }
      }

    } catch (scrapingError) {
      console.error('Scraping service error:', scrapingError);
      
      // Mark all URLs as failed if scraping service fails
      for (const profile of validProfiles) {
        results.processed++;
        results.failed++;
        results.results.push({ 
          url: profile.url, 
          status: 'failed', 
          error: 'LinkedIn scraping service failed'
        });
      }
    }

    // Update user points using API endpoint
    if (results.successful > 0) {
      try {
        // You'll need to implement a user points update endpoint
        // For now, we'll skip this or you can add it to your existing user routes
        console.log(`Would add ${results.successful * 10} points to user ${userId}`);
      } catch (pointsError) {
        console.error('Error updating user points:', pointsError);
        // Don't fail the entire operation for points update failure
      }
    }

    // Return results
    res.json({
      success: true,
      results,
      pointsEarned: results.successful * 10
    });

  } catch (error) {
    console.error('LinkedIn scraping API error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Updated helper function to transform LinkedIn data with user-provided phone info only
function transformLinkedInDataWithPhone(linkedInProfile, userId, profileInput) {
  if (!linkedInProfile) {
    throw new Error('No profile data received');
  }

  // Ensure extraLinks are properly handled from profileInput
  const extraLinks = Array.isArray(profileInput.extraLinks) ? profileInput.extraLinks.filter(Boolean) : [];

  // Extract work experience description from positions array
  let workExperience = '';
  if (linkedInProfile.positions && linkedInProfile.positions.length > 0) {
    workExperience = linkedInProfile.positions
      .map(position => {
        const title = position.title || '';
        const company = position.companyName || position.company?.name || '';
        const description = position.description || '';
        const location = position.locationName || '';
        
        // Format date range
        let dateRange = '';
        if (position.timePeriod) {
          const start = position.timePeriod.startDate;
          const end = position.timePeriod.endDate;
          
          if (start) {
            const startMonth = start.month ? String(start.month).padStart(2, '0') : '';
            const startYear = start.year || '';
            const startStr = startMonth && startYear ? `${startMonth}/${startYear}` : startYear;
            
            let endStr = 'Present';
            if (end) {
              const endMonth = end.month ? String(end.month).padStart(2, '0') : '';
              const endYear = end.year || '';
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
      .join('\n\n---\n\n');
  }

  // Extract skills from multiple sources: skills array, courses, and certifications
  let skills = [];
  
  // Primary skills from skills array
  if (linkedInProfile.skills && Array.isArray(linkedInProfile.skills)) {
    const primarySkills = linkedInProfile.skills.map(skill => 
      typeof skill === 'string' ? skill : skill.name || skill.title || ''
    ).filter(skill => skill.trim());
    skills.push(...primarySkills);
  }
  
  // Additional skills from courses
  if (linkedInProfile.courses && Array.isArray(linkedInProfile.courses)) {
    const courseSkills = linkedInProfile.courses.map(course => 
      typeof course === 'string' ? course : course.name || course.title || ''
    ).filter(skill => skill.trim());
    skills.push(...courseSkills);
  }
  
  // Additional skills from certifications
  if (linkedInProfile.certifications && Array.isArray(linkedInProfile.certifications)) {
    const certificationSkills = linkedInProfile.certifications
      .map(cert => typeof cert === 'string' ? cert : cert.name || cert.title || '')
      .filter(skill => skill.trim())
      .slice(0, 10); // Limit certifications to avoid too many skills
    skills.push(...certificationSkills);
  }
  
  // Remove duplicates and limit total skills
  skills = [...new Set(skills)].slice(0, 25); // Remove duplicates and limit to 25 skills

  // Extract education from educations array  
  let education = '';
  if (linkedInProfile.educations && linkedInProfile.educations.length > 0) {
    education = linkedInProfile.educations
      .map(edu => {
        const degree = edu.degreeName || '';
        const field = edu.fieldOfStudy || '';
        const school = edu.schoolName || '';
        
        let educationText = '';
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
            const timeStr = start && end ? `${start}-${end}` : start ? `${start}` : `${end}`;
            educationText += ` (${timeStr})`;
          }
        }
        
        return educationText;
      })
      .filter(edu => edu.trim())
      .join('; ');
  }

  // Determine industry from profile data or positions
  let industry = linkedInProfile.industryName || 'Other';
  if (!industry || industry === 'Other') {
    if (linkedInProfile.positions && linkedInProfile.positions.length > 0) {
      const currentPosition = linkedInProfile.positions[0];
      if (currentPosition.company?.industries && currentPosition.company.industries.length > 0) {
        industry = currentPosition.company.industries[0];
      }
    }
  }

  // Calculate total experience years based on all positions
  let experienceYears = 0;
  if (linkedInProfile.positions && linkedInProfile.positions.length > 0) {
    // Find the earliest start date across all positions
    let earliestStartYear = null;
    
    linkedInProfile.positions.forEach(position => {
      if (position.timePeriod && position.timePeriod.startDate && position.timePeriod.startDate.year) {
        if (!earliestStartYear || position.timePeriod.startDate.year < earliestStartYear) {
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
  const jobTitle = linkedInProfile.jobTitle || linkedInProfile.occupation || linkedInProfile.positions?.[0]?.title || '';
  let seniorityLevel = 'Mid-level';
  const titleLower = jobTitle.toLowerCase();
  
  if (titleLower.includes('ceo') || titleLower.includes('cto') || titleLower.includes('cfo') || titleLower.includes('chief')) {
    seniorityLevel = 'C-Level';
  } else if (titleLower.includes('vp') || titleLower.includes('vice president')) {
    seniorityLevel = 'VP';
  } else if (titleLower.includes('director') || titleLower.includes('manager')) {
    seniorityLevel = 'Director';
  } else if (titleLower.includes('senior') || titleLower.includes('lead') || titleLower.includes('principal')) {
    seniorityLevel = 'Senior';
  } else if (titleLower.includes('junior') || experienceYears < 2) {
    seniorityLevel = 'Entry-level';
  }

  // Extract company size
  let companySize = '';
  if (linkedInProfile.positions && linkedInProfile.positions.length > 0) {
    const currentPosition = linkedInProfile.positions[0];
    if (currentPosition.company?.employeeCountRange) {
      const range = currentPosition.company.employeeCountRange;
      companySize = `${range.start}-${range.end} employees`;
    }
  }

  // Get location from profile or current position
  const location = linkedInProfile.geoLocationName || linkedInProfile.geoCountryName || 
                  linkedInProfile.positions?.[0]?.locationName || '';

  // Use user-provided phone info as priority, fallback to LinkedIn data
  const finalPhone = profileInput.phone || linkedInProfile.phone || '';

  return {
    name: `${linkedInProfile.firstName || ''} ${linkedInProfile.lastName || ''}`.trim() || linkedInProfile.fullName || '',
    jobTitle,
    company: linkedInProfile.companyName || linkedInProfile.positions?.[0]?.companyName || '',
    location,
    industry,
    experience: experienceYears,
    seniorityLevel,
    skills,
    education,
    workExperience,
    email: profileInput.email || linkedInProfile.email || '', // Prioritize user-provided email
    phone: finalPhone, // Prioritize user-provided phone
    avatar: linkedInProfile.pictureUrl || linkedInProfile.profilePicture || 'https://images.pexels.com/photos/771742/pexels-photo-771742.jpeg?auto=compress&cs=tinysrgb&w=150&h=150&fit=crop',
    uploadedBy: userId,
    companySize,
    linkedinUrl: linkedInProfile.inputUrl || linkedInProfile.url || linkedInProfile.linkedinUrl || profileInput.url,
    extraLinks: profileInput.extraLinks || []
  };
}

module.exports = router;