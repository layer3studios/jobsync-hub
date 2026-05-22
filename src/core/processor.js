// ─── WORKDAY FIELD MAPPING ─────────────────────────────────────
function mapWorkdayJob(raw, companyName, sourceSite) {
    // Description and other details will be filled by getDetails
    let workplaceType = null;
    let isRemote = null;
    if (raw.remoteType && typeof raw.remoteType === 'string') {
        workplaceType = raw.remoteType.toLowerCase();
        isRemote = workplaceType === 'fully remote' || workplaceType === 'remote';
    } else if ((raw.locationsText || '').toLowerCase().includes('remote')) {
        workplaceType = 'remote';
        isRemote = true;
    }
    return {
        JobID: raw.bulletFields?.[0] ? `workday_${raw._company}_${raw.bulletFields[0]}` : null,
        JobTitle: raw.title || null,
        Company: companyName,
        ApplicationURL: null, // Filled by getDetails
        DirectApplyURL: null, // Filled by getDetails
        Location: raw.locationsText || null,
        AllLocations: raw.locationsText ? [raw.locationsText] : [],
        Department: null, // Could be inferred from jobFamily facet if needed
        Team: null,
        Office: null,
        ContractType: null, // Filled by getDetails
        WorkplaceType: workplaceType,
        IsRemote: isRemote,
        Tags: [],
        Description: null, // Filled by getDetails
        DescriptionPlain: null, // Filled by getDetails
        DescriptionLists: [],
        AdditionalInfo: null,
        SalaryMin: null,
        SalaryMax: null,
        SalaryCurrency: null,
        SalaryInterval: null,
        SalaryInfo: null,
        PostedDate: null, // Filled by getDetails
        sourceSite: sourceSite,
        ATSPlatform: 'workday',
        Status: 'active',
        scrapedAt: new Date(),
    };
}
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import { AbortController } from 'abort-controller';

import { createJobModel } from '../models/jobModel.js';
import { BANNED_ROLES, TECH_ROLE_KEYWORDS } from '../utils.js';

/**
 * Centralised PostedDate validator.
 * - Accepts ISO strings, Unix millisecond timestamps (number or numeric string)
 * - Rejects dates older than MAX_AGE_DAYS (90 days by default)
 * - Rejects dates more than 2 days in the future (clock skew tolerance)
 * Returns a valid Date or null.
 */
const MAX_AGE_DAYS = 90;
function validatePostedDate(raw, label) {
    if (!raw && raw !== 0) return null;
    let d;
    // Handle Unix millisecond timestamp (number or numeric string)
    const asNum = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d{10,13}$/.test(raw.trim()) ? Number(raw) : NaN);
    if (!isNaN(asNum)) {
        // 13-digit = ms, 10-digit = seconds
        d = new Date(asNum > 1e11 ? asNum : asNum * 1000);
    } else {
        d = new Date(raw);
    }
    if (isNaN(d.getTime())) return null;

    const now = Date.now();
    const ageMs = now - d.getTime();
    const maxMs = MAX_AGE_DAYS * 86400000;
    const futureMs = 2 * 86400000; // 2-day tolerance

    if (ageMs > maxMs) {
        console.warn(`[processor] PostedDate too old (${MAX_AGE_DAYS}d limit) ${label ? '(' + label + ')' : ''}: ${raw} → ${d.toISOString()}`);
        return null;
    }
    if (d.getTime() > now + futureMs) {
        console.warn(`[processor] PostedDate in the future ${label ? '(' + label + ')' : ''}: ${raw} → ${d.toISOString()}`);
        return null;
    }
    return d;
}

function isSpamOrIrrelevant(title) {
    const lowerTitle = title.toLowerCase();
    return BANNED_ROLES.some(role => lowerTitle.includes(role));
}

// ─── Tech-role gate: accept all tech jobs regardless of seniority
function isTechRole(title) {
    const t = title.toLowerCase();
    return TECH_ROLE_KEYWORDS.some(kw => t.includes(kw));
}

// ─── Infer ExperienceLevel from title (tagging only; no rejection) ─────────
function inferExperienceLevel(title) {
    const t = title.toLowerCase();
    if (/intern\b/.test(t)) return 'Intern';
    if (['sde-1', 'sde 1', 'sde-i', 'sde i', 'junior', 'jr.', 'jr ', 'fresher', 'trainee', 'graduate', 'entry level', 'entry-level'].some(k => t.includes(k))) return 'Entry Level';
    if (['senior', 'sr.', 'sr ', 'staff', 'principal'].some(k => t.includes(k))) return 'Senior';
    if (['lead', 'head', 'director', 'vp ', 'chief'].some(k => t.includes(k))) return 'Leadership';
    if (['manager'].some(k => t.includes(k))) return 'Manager';
    return 'Mid Level';
}

// ─── Ashby employmentType normalization ──────────────────────────
function normalizeEmploymentType(raw) {
    const map = { FullTime: 'Full-time', PartTime: 'Part-time', Intern: 'Internship', Temporary: 'Temporary', Contract: 'Contract' };
    return map[raw] || raw || null;
}

// ─── Lever workplaceType normalization ───────────────────────────
function normalizeLeverWorkplace(wt) {
    if (!wt || wt === 'unspecified') return null;
    if (wt === 'onSite') return 'on-site';
    return wt; // 'remote' and 'hybrid' pass through
}

// ─── LEVER FIELD MAPPING ─────────────────────────────────────────
function mapLeverJob(raw, companyName, sourceSite) {
    const cats = raw.categories || {};
    const salary = raw.salaryRange || {};

    let postedDate = null;
    if (raw.createdAt) {
        postedDate = validatePostedDate(raw.createdAt, `Lever/${raw.id}`);
    }

    return {
        JobID: raw.id || null,
        JobTitle: raw.text || null,
        Company: companyName,
        ApplicationURL: raw.hostedUrl || raw.applyUrl || null,
        DirectApplyURL: raw.applyUrl || null,
        Location: cats.location || null,
        AllLocations: Array.isArray(cats.allLocations) ? cats.allLocations : [],
        Department: cats.department || null,
        Team: cats.team || null,
        ContractType: cats.commitment || null,
        WorkplaceType: normalizeLeverWorkplace(raw.workplaceType),
        IsRemote: raw.workplaceType === 'remote' ? true : (raw.workplaceType && raw.workplaceType !== 'unspecified' ? false : null),
        Tags: Array.isArray(raw.tags) ? raw.tags : [],
        Description: raw.description || null,
        DescriptionPlain: raw.descriptionPlain || null,
        DescriptionLists: Array.isArray(raw.lists) ? raw.lists : [],
        AdditionalInfo: raw.additional || null,
        SalaryMin: salary.min ?? null,
        SalaryMax: salary.max ?? null,
        SalaryCurrency: salary.currency || null,
        SalaryInterval: salary.interval || null,
        SalaryInfo: null,
        PostedDate: postedDate,
        sourceSite: sourceSite,
        ATSPlatform: 'lever',
        Status: 'active',
        scrapedAt: new Date(),
    };
}

// ─── GREENHOUSE FIELD MAPPING ────────────────────────────────────
function mapGreenhouseJob(raw, companyName, sourceSite) {
    let postedDate = null;
    if (raw.updated_at) {
        postedDate = validatePostedDate(raw.updated_at, `Greenhouse/${raw.id}`);
    }

    let salaryInfo = null;
    if (Array.isArray(raw.metadata)) {
        const salaryMeta = raw.metadata.find(m =>
            (m.name && m.name.toLowerCase().includes('salary')) ||
            (m.name && m.name.toLowerCase().includes('compensation'))
        );
        if (salaryMeta && salaryMeta.value) salaryInfo = String(salaryMeta.value);
    }

    const depts = Array.isArray(raw.departments) ? raw.departments : [];
    const offices = Array.isArray(raw.offices) ? raw.offices : [];

    // Infer workplace type from location string
    const locName = (raw.location?.name || '').toLowerCase();
    let workplaceType = null;
    let isRemote = null;
    if (locName.includes('remote')) {
        workplaceType = 'remote';
        isRemote = true;
    } else if (locName.includes('hybrid')) {
        workplaceType = 'hybrid';
        isRemote = false;
    } else if (locName) {
        workplaceType = 'on-site';
        isRemote = false;
    }

    // Build AllLocations from offices
    const allLocs = offices.map(o => o.name).filter(Boolean);

    // Strip HTML for plain text
    const descPlain = raw.content ? raw.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null;

    return {
        JobID: String(raw.id || ''),
        JobTitle: raw.title || null,
        Company: companyName,
        ApplicationURL: raw.absolute_url || null,
        DirectApplyURL: null,
        Location: raw.location?.name || null,
        AllLocations: allLocs,
        Department: depts[0]?.name || null,
        Team: null,
        Office: offices[0]?.name || null,
        ContractType: null,
        WorkplaceType: workplaceType,
        IsRemote: isRemote,
        Tags: [],
        Description: raw.content || null,
        DescriptionPlain: descPlain,
        DescriptionLists: [],
        AdditionalInfo: null,
        SalaryMin: null,
        SalaryMax: null,
        SalaryCurrency: null,
        SalaryInterval: null,
        SalaryInfo: salaryInfo,
        PostedDate: postedDate,
        sourceSite: sourceSite,
        ATSPlatform: 'greenhouse',
        Status: 'active',
        scrapedAt: new Date(),
    };
}

// ─── WORKABLE FIELD MAPPING ─────────────────────────────────────
function mapWorkableJob(raw, companyName, sourceSite) {
    let postedDate = null;
    if (raw.published_on) {
        postedDate = validatePostedDate(raw.published_on, `Workable/${raw.shortcode}`);
    }
    if (!postedDate && raw.created_at) {
        postedDate = validatePostedDate(raw.created_at, `Workable/${raw.shortcode}/created_at`);
    }

    const wt = raw.workplace_type;
    let workplaceType = null;
    let isRemote = null;
    if (wt === 'remote') {
        workplaceType = 'remote';
        isRemote = true;
    } else if (wt === 'hybrid') {
        workplaceType = 'hybrid';
        isRemote = false;
    } else if (wt === 'on_site') {
        workplaceType = 'on-site';
        isRemote = false;
    } else if (raw.telecommuting === true) {
        workplaceType = 'remote';
        isRemote = true;
    }

    const locationParts = [raw.city, raw.state, raw.country].filter(Boolean);
    const location = locationParts.join(', ') || null;
    const allLocs = location ? [location] : [];

    const descPlain = raw.description
        ? raw.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        : null;

    return {
        JobID: raw.shortcode || null,       // overwritten by extractJobID
        JobTitle: raw.title || null,
        Company: companyName,
        ApplicationURL: raw.application_url || raw.shortlink || raw.url || null,
        DirectApplyURL: raw.application_url || null,
        Location: location,
        AllLocations: allLocs,
        Department: raw.department || null,
        Team: null,
        Office: null,
        ContractType: raw.employment_type || null,
        WorkplaceType: workplaceType,
        IsRemote: isRemote,
        Tags: [],
        Description: raw.description || null,
        DescriptionPlain: descPlain,
        DescriptionLists: [],
        AdditionalInfo: [
            raw.experience ? `Experience: ${raw.experience}` : null,
            raw.education ? `Education: ${raw.education}` : null,
        ].filter(Boolean).join(' | ') || null,
        SalaryMin: null,
        SalaryMax: null,
        SalaryCurrency: null,
        SalaryInterval: null,
        SalaryInfo: null,
        PostedDate: postedDate,
        sourceSite: sourceSite,
        ATSPlatform: 'workable',
        Status: 'active',
        scrapedAt: new Date(),
    };
}

// ─── ASHBY FIELD MAPPING ─────────────────────────────────────────
function mapAshbyJob(raw, companyName, sourceSite) {
    let postedDate = null;
    if (raw.publishedDate) {
        postedDate = validatePostedDate(raw.publishedDate, `Ashby/${raw.id}`);
    }
    if (!postedDate && raw.createdAt) {
        postedDate = validatePostedDate(raw.createdAt, `Ashby/${raw.id}/createdAt`);
    }

    // Build AllLocations from primary + secondary
    const allLocs = [];
    if (raw.location) allLocs.push(raw.location);
    if (Array.isArray(raw.secondaryLocations)) {
        for (const sec of raw.secondaryLocations) {
            if (sec.location && !allLocs.includes(sec.location)) allLocs.push(sec.location);
        }
    }

    // Determine workplace type
    const locLower = (raw.location || '').toLowerCase();
    let ashbyWorkplace = null;
    if (raw.isRemote === true) {
        ashbyWorkplace = 'remote';
    } else if (locLower.includes('hybrid')) {
        ashbyWorkplace = 'hybrid';
    } else if (raw.isRemote === false) {
        ashbyWorkplace = 'on-site';
    }

    return {
        JobID: raw.id || null,
        JobTitle: raw.title || null,
        Company: companyName,
        ApplicationURL: raw.jobUrl || null,
        DirectApplyURL: raw.applyUrl || null,
        Location: raw.location || null,
        AllLocations: allLocs,
        Department: raw.team?.name || null,
        Team: raw.team?.name || null,
        Office: null,
        ContractType: normalizeEmploymentType(raw.employmentType),
        WorkplaceType: ashbyWorkplace,
        IsRemote: raw.isRemote ?? null,
        Tags: [],
        Description: raw.descriptionHtml || null,
        DescriptionPlain: raw.descriptionPlain || null,
        DescriptionLists: [],
        AdditionalInfo: null,
        SalaryMin: null,
        SalaryMax: null,
        SalaryCurrency: null,
        SalaryInterval: null,
        SalaryInfo: raw.compensation?.compensationTierSummary || null,
        PostedDate: postedDate,
        sourceSite: sourceSite,
        ATSPlatform: 'ashby',
        Status: 'active',
        scrapedAt: new Date(),
    };
}

// ─── RECRUITEE FIELD MAPPING ────────────────────────────────────
function normalizeRecruiteeEmploymentType(rawCode) {
    const map = {
        fulltime: 'Full-time',
        parttime: 'Part-time',
        internship: 'Internship',
        freelance: 'Freelance',
        contract: 'Contract',
        temporary: 'Temporary',
    };
    return map[rawCode] || rawCode || null;
}

function normalizeRecruiteeWorkplace(raw) {
    if (raw.hybrid === true) return { workplaceType: 'hybrid', isRemote: false };
    if (raw.remote === true && raw.on_site === true) return { workplaceType: 'hybrid', isRemote: false };
    if (raw.remote === true) return { workplaceType: 'remote', isRemote: true };
    if (raw.on_site === true) return { workplaceType: 'on-site', isRemote: false };
    return { workplaceType: null, isRemote: null };
}

function mapRecruiteeJob(raw, companyName, sourceSite) {
    let postedDate = null;
    if (raw.published_at) {
        postedDate = validatePostedDate(raw.published_at, `Recruitee/${raw.id}`);
    }
    if (!postedDate && raw.created_at) {
        postedDate = validatePostedDate(raw.created_at, `Recruitee/${raw.id}/created_at`);
    }

    const allLocs = Array.isArray(raw.locations)
        ? raw.locations
            .map(loc => [loc.city, loc.state, loc.country].filter(Boolean).join(', '))
            .filter(Boolean)
        : [];

    let primaryLoc = null;
    if (Array.isArray(raw.locations) && raw.locations.length > 0) {
        const indiaLoc = raw.locations.find(loc =>
            loc?.country_code === 'IN'
            || (loc?.country && String(loc.country).toLowerCase() === 'india')
        );
        const chosen = indiaLoc || raw.locations[0];
        primaryLoc = [chosen?.city, chosen?.state, chosen?.country].filter(Boolean).join(', ') || null;
    }

    const descriptionParts = [raw.description, raw.requirements].filter(Boolean);
    const descriptionHtml = descriptionParts.join('\n\n') || null;
    const descriptionPlain = descriptionHtml
        ? descriptionHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        : null;

    const workplace = normalizeRecruiteeWorkplace(raw);

    return {
        JobID: raw.id ? String(raw.id) : null,
        JobTitle: raw.title || null,
        Company: raw.company_name || companyName,
        ApplicationURL: raw.careers_apply_url || raw.careers_url || null,
        DirectApplyURL: raw.careers_apply_url || null,
        Location: primaryLoc,
        AllLocations: allLocs,
        Department: raw.department || null,
        Team: null,
        Office: null,
        ContractType: normalizeRecruiteeEmploymentType(raw.employment_type_code),
        WorkplaceType: workplace.workplaceType,
        IsRemote: workplace.isRemote,
        Tags: Array.isArray(raw.tags) ? raw.tags : [],
        Description: descriptionHtml,
        DescriptionPlain: descriptionPlain,
        DescriptionLists: [],
        AdditionalInfo: [
            raw.category_code ? `Category: ${raw.category_code}` : null,
            raw.education_code ? `Education: ${raw.education_code}` : null,
        ].filter(Boolean).join(' | ') || null,
        SalaryMin: raw.salary?.min ?? null,
        SalaryMax: raw.salary?.max ?? null,
        SalaryCurrency: raw.salary?.currency || null,
        SalaryInterval: raw.salary?.period || null,
        SalaryInfo: null,
        ExperienceLevel: raw.experience_code || null,
        PostedDate: postedDate,
        sourceSite: sourceSite,
        ATSPlatform: 'recruitee',
        Status: 'active',
        scrapedAt: new Date(),
    };
}

async function scrapeJobDetailsFromPage(mappedJob, siteConfig) {
    console.log(`[${siteConfig.siteName}] Visiting job page: ${mappedJob.ApplicationURL}`);
    const pageController = new AbortController();
    const pageTimeoutId = setTimeout(() => pageController.abort(), 30000);
    try {
        const jobPageRes = await fetch(mappedJob.ApplicationURL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'text/html,application/xhtml+xml',
            },
            signal: pageController.signal
        });
        const html = await jobPageRes.text();
        const dom = new JSDOM(html);
        const document = dom.window.document;
        if (siteConfig.descriptionSelector) {
            const descriptionElement = document.querySelector(siteConfig.descriptionSelector);
            if (descriptionElement) {
                mappedJob.Description = descriptionElement.textContent.replace(/\s+/g, ' ').trim();
            }
        }
    } catch (error) {
        console.error(`[Scrape Error] ${error.message}`);
    } finally {
        clearTimeout(pageTimeoutId);
    }
    return mappedJob;
}


export async function processJob(rawJob, siteConfig, existingIDs, sessionHeaders, allRawJobs) {
    // 1. Config Pre-Filter
    if (siteConfig.preFilter && !siteConfig.preFilter(rawJob)) return null;

    // Determine platform from siteName
    const siteName = siteConfig.siteName || '';
    const isLever = siteName.toLowerCase().includes('lever');
    const isGreenhouse = siteName.toLowerCase().includes('greenhouse');
    const isAshby = siteName.toLowerCase().includes('ashby');
    const isWorkable = siteName.toLowerCase().includes('workable');
    const isRecruitee = siteName.toLowerCase().includes('recruitee');
    const isWorkday = siteName.toLowerCase().includes('workday');

    // Extract job data using rich mappers
    let mappedJob;
    if (isLever) {
        const companyName = siteConfig.extractCompany ? siteConfig.extractCompany(rawJob) : siteName;
        const jobID = siteConfig.extractJobID ? siteConfig.extractJobID(rawJob) : rawJob.id;
        mappedJob = mapLeverJob(rawJob, companyName, siteName);
        mappedJob.JobID = jobID;
    } else if (isGreenhouse) {
        const companyName = siteConfig.extractCompany ? siteConfig.extractCompany(rawJob) : siteName;
        const jobID = siteConfig.extractJobID ? siteConfig.extractJobID(rawJob) : String(rawJob.id);
        mappedJob = mapGreenhouseJob(rawJob, companyName, siteName);
        mappedJob.JobID = jobID;
    } else if (isAshby) {
        const companyName = siteConfig.extractCompany ? siteConfig.extractCompany(rawJob) : siteName;
        const jobID = siteConfig.extractJobID ? siteConfig.extractJobID(rawJob) : rawJob.id;
        mappedJob = mapAshbyJob(rawJob, companyName, siteName);
        mappedJob.JobID = jobID;
    } else if (isWorkable) {
        const companyName = siteConfig.extractCompany ? siteConfig.extractCompany(rawJob) : siteName;
        const jobID = siteConfig.extractJobID ? siteConfig.extractJobID(rawJob) : rawJob.shortcode;
        mappedJob = mapWorkableJob(rawJob, companyName, siteName);
        mappedJob.JobID = jobID;
    } else if (isRecruitee) {
        const companyName = siteConfig.extractCompany ? siteConfig.extractCompany(rawJob) : siteName;
        const jobID = siteConfig.extractJobID ? siteConfig.extractJobID(rawJob) : rawJob.id;
        mappedJob = mapRecruiteeJob(rawJob, companyName, siteName);
        mappedJob.JobID = jobID;
    } else if (isWorkday) {
        const companyName = siteConfig.extractCompany ? siteConfig.extractCompany(rawJob) : siteName;
        const jobID = siteConfig.extractJobID ? siteConfig.extractJobID(rawJob) : (rawJob.bulletFields?.[0] ? `workday_${rawJob._company}_${rawJob.bulletFields[0]}` : null);
        mappedJob = mapWorkdayJob(rawJob, companyName, siteName);
        mappedJob.JobID = jobID;
    } else if (siteConfig.extractJobID) {
        // Fallback for unknown platforms using legacy extractors
        mappedJob = {
            JobID: siteConfig.extractJobID(rawJob),
            JobTitle: siteConfig.extractJobTitle(rawJob),
            Company: siteConfig.extractCompany(rawJob),
            Location: siteConfig.extractLocation(rawJob),
            Description: siteConfig.extractDescription(rawJob),
            ApplicationURL: siteConfig.extractURL(rawJob),
            PostedDate: siteConfig.extractPostedDate ? siteConfig.extractPostedDate(rawJob) : null,
        };
    } else {
        mappedJob = siteConfig.mapper(rawJob);
    }

    if (!mappedJob.JobID) {
        return null;
    }

    if (allRawJobs && allRawJobs instanceof Set) {
        allRawJobs.add(mappedJob.JobID);
    }

    // 2. Duplicate Check
    if (existingIDs.has(mappedJob.JobID)) {
        return null;
    }

    // 3. Spam filter
    if (isSpamOrIrrelevant(mappedJob.JobTitle)) {
        console.log(`[Pre-Filter] Rejected (spam): ${mappedJob.JobTitle}`);
        return null;
    }

    // 3b. Tech role gate — only accept tech jobs
    if (!isTechRole(mappedJob.JobTitle)) {
        console.log(`[Pre-Filter] Rejected (non-tech): ${mappedJob.JobTitle}`);
        return null;
    }

    // 3c. Set ExperienceLevel
    mappedJob.ExperienceLevel = mappedJob.ExperienceLevel || inferExperienceLevel(mappedJob.JobTitle);

    // 4. Keyword Match
    if (siteConfig.filterKeywords && siteConfig.filterKeywords.length > 0) {
        const titleLower = mappedJob.JobTitle.toLowerCase();
        if (!siteConfig.filterKeywords.some(kw => titleLower.includes(kw.toLowerCase()))) return null;
    }

    // 5. Get Description
    if ((siteConfig.needsDescriptionScraping && !mappedJob.Description)) {
        if (typeof siteConfig.getDetails === 'function') {
            try {
                const details = await siteConfig.getDetails(rawJob, sessionHeaders);

                if (details && details.skip) {
                    console.log(`[${siteConfig.siteName}] Job skipped by getDetails`);
                    return null;
                }

                if (details) {
                    Object.assign(mappedJob, details);
                }
            } catch (error) {
                console.error(`[${siteConfig.siteName}] getDetails error: ${error.message}`);
                return null;
            }
        } else {
            mappedJob = await scrapeJobDetailsFromPage(mappedJob, siteConfig);
        }
    }

    if (!mappedJob.Description) return null;

    // Job accepted — save as active
    mappedJob.Status = "active";



    return createJobModel(mappedJob, siteConfig.siteName);
}