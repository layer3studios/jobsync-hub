import { ObjectId } from 'mongodb';
import { connectToDb } from './connection.js';
import { SITES_CONFIG } from '../config.js';
import { createJobModel } from '../models/jobModel.js';
import { StripHtml } from '../utils.js';
import { categorizeJob, ALL_CATEGORIES } from '../core/categorize.js';

export async function loadAllExistingIDs() {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const existingIDsMap = new Map();
    for (const siteConfig of SITES_CONFIG) {
        const siteName = siteConfig.siteName;
        const idSet = new Set();
        const jobs = await jobsCollection.find({ sourceSite: siteName }, { projection: { JobID: 1 } }).toArray();
        jobs.forEach(job => idSet.add(job.JobID));
        existingIDsMap.set(siteName, idSet);
        console.log(`[${siteName}] Found ${idSet.size} existing jobs in the database.`);
    }
    return existingIDsMap;
}

export async function saveJobs(jobs) {
    if (jobs.length === 0) return;
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    const operations = jobs.map(job => {
        const { createdAt, updatedAt, ...pureJobData } = job;
        // ── Compute Category at write time (deterministic, no AI) ──────────
        // This runs once per upsert. Filter queries then use indexed Category
        // lookups instead of classifying every job on every API request.
        const Category = categorizeJob(pureJobData);
        return {
            updateOne: {
                filter: { JobID: job.JobID, sourceSite: job.sourceSite },
                update: {
                    $set: {
                        ...pureJobData,
                        Category,
                        updatedAt: new Date(),
                        scrapedAt: new Date()
                    },
                    $setOnInsert: { createdAt: new Date() }
                },
                upsert: true,
            },
        };
    });

    await jobsCollection.bulkWrite(operations);
}


export async function saveJobTestLog(jobTestLog) {
    if (!jobTestLog) return;
    const db = await connectToDb();
    const testLogsCollection = db.collection('jobTestLogs');

    // Ensure fingerprint index exists (runs once, no-ops after that)
    await testLogsCollection.createIndex({ fingerprint: 1 }, { background: true }).catch(() => { });

    const { createdAt, ...pureJobData } = jobTestLog;

    await testLogsCollection.updateOne(
        { JobID: jobTestLog.JobID, sourceSite: jobTestLog.sourceSite },
        {
            $set: {
                ...pureJobData,
                scrapedAt: new Date()
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );
}

/**
 * Looks up a job test log by its fingerprint hash.
 * If found, returns the AI classification result so we can skip re-analysis.
 * 
 * @param {string} fingerprint - MD5 hash from generateJobFingerprint()
 * @returns {object|null} The cached AI result, or null if not found
 */
export async function findTestLogByFingerprint(fingerprint) {
    if (!fingerprint) return null;
    const db = await connectToDb();
    const testLogsCollection = db.collection('jobTestLogs');

    const log = await testLogsCollection.findOne(
        { fingerprint: fingerprint },
        {
            projection: {
                GermanRequired: 1,
                Domain: 1,
                SubDomain: 1,
                ConfidenceScore: 1,
                Evidence: 1,
                FinalDecision: 1,
                RejectionReason: 1,
                fingerprint: 1,
            }
        }
    );

    return log || null;
}

export async function deleteOldJobs(siteName, scrapeStartTime) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fourteenDaysAgo = new Date(now);
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

    let totalDeleted = 0;

    // ── Rule 1: NEVER delete admin-approved jobs (active + reviewedAt) ──
    // These are only removed by the URL validator (404 check) or manual admin action.
    // No query needed — we simply exclude them from all delete operations below.

    // ── Rule 2: NEVER delete curated (manually added) jobs ──
    // sourceSite === "Curated" means admin added it manually via Add Job form.
    // We exclude this in every query below with: sourceSite: siteName
    // Since siteName comes from SITES_CONFIG (Greenhouse/Ashby/Lever), it never equals "Curated".

    // ── Rule 3: Delete AI-rejected jobs older than 7 days ──
    // These are jobs the AI flagged as "German required" — never shown to users.
    const aiRejectedResult = await jobsCollection.deleteMany({
        sourceSite: siteName,
        Status: 'rejected',
        $or: [
            { reviewedAt: { $exists: false } },
            { reviewedAt: null }
        ],
        updatedAt: { $lt: sevenDaysAgo }
    });
    if (aiRejectedResult.deletedCount > 0) {
        console.log(`[${siteName}] 🗑️  Deleted ${aiRejectedResult.deletedCount} AI-rejected jobs (>7 days old)`);
        totalDeleted += aiRejectedResult.deletedCount;
    }

    // ── Rule 4: Delete admin-rejected jobs older than 14 days ──
    // Admin explicitly rejected these. Keep longer for reference, then clean.
    const adminRejectedResult = await jobsCollection.deleteMany({
        sourceSite: siteName,
        Status: 'rejected',
        reviewedAt: { $exists: true, $ne: null },
        updatedAt: { $lt: fourteenDaysAgo }
    });
    if (adminRejectedResult.deletedCount > 0) {
        console.log(`[${siteName}] 🗑️  Deleted ${adminRejectedResult.deletedCount} admin-rejected jobs (>14 days old)`);
        totalDeleted += adminRejectedResult.deletedCount;
    }

    // ── Rule 5: Delete pending_review jobs older than 14 days ──
    // Admin had 2 weeks to review. If they didn't, the job is probably stale/filled.
    const pendingResult = await jobsCollection.deleteMany({
        sourceSite: siteName,
        Status: 'pending_review',
        updatedAt: { $lt: fourteenDaysAgo }
    });
    if (pendingResult.deletedCount > 0) {
        console.log(`[${siteName}] 🗑️  Deleted ${pendingResult.deletedCount} stale pending jobs (>14 days old)`);
        totalDeleted += pendingResult.deletedCount;
    }

    // ── Rule 6: Delete auto-approved active jobs (no reviewedAt) older than 14 days ──
    // Rare case: jobs that became active without manual review. Keep longer, then clean.
    const autoActiveResult = await jobsCollection.deleteMany({
        sourceSite: siteName,
        Status: 'active',
        $or: [
            { reviewedAt: { $exists: false } },
            { reviewedAt: null }
        ],
        updatedAt: { $lt: fourteenDaysAgo }
    });
    if (autoActiveResult.deletedCount > 0) {
        console.log(`[${siteName}] 🗑️  Deleted ${autoActiveResult.deletedCount} auto-active jobs with no review (>14 days old)`);
        totalDeleted += autoActiveResult.deletedCount;
    }

    // ── Summary ──
    if (totalDeleted > 0) {
        console.log(`[${siteName}] 🗑️  Total cleanup: ${totalDeleted} jobs deleted`);
    } else {
        console.log(`[${siteName}] ✅ Cleanup: nothing to delete`);
    }

    return totalDeleted;
}

export async function deleteJobById(jobId) {
    try {
        const db = await connectToDb();
        const jobsCollection = db.collection('jobs');
        await jobsCollection.deleteOne({ _id: jobId });
    } catch (error) {
        console.error(`Error deleting job ${jobId}:`, error);
    }
}

export async function addCuratedJob(jobData) {
    if (!jobData.JobTitle || !jobData.ApplicationURL || !jobData.Company) {
        throw new Error('Job Title, URL, and Company are required.');
    }
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const existingJob = await jobsCollection.findOne({ ApplicationURL: jobData.ApplicationURL });
    if (existingJob) {
        throw new Error('This Application URL already exists in the database.');
    }
    const jobID = `curated-${new Date().getTime()}`;

    const jobToSave = createJobModel({
        JobID: jobID,
        JobTitle: jobData.JobTitle,
        ApplicationURL: jobData.ApplicationURL,
        Company: jobData.Company,
        Location: jobData.Location,
        Department: jobData.Department,
        GermanRequired: jobData.GermanRequired ?? false,
        Description: jobData.Description || `Manually curated: ${jobData.JobTitle}`,
        PostedDate: jobData.PostedDate || new Date().toISOString(),
        ContractType: jobData.ContractType,
        ExperienceLevel: jobData.ExperienceLevel,
        isManual: true,
        Status: 'active'
    }, "Curated");

    await saveJobs([jobToSave]);
    return jobToSave;
}

export async function getAllJobs(page = 1, limit = 50) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const skip = (page - 1) * limit;
    const totalJobs = await jobsCollection.countDocuments();
    const jobs = await jobsCollection.find({})
        .sort({ PostedDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
    return {
        jobs,
        totalJobs,
        totalPages: Math.ceil(totalJobs / limit),
        currentPage: page
    };
}

export async function getPublicBaitJobs() {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    const jobs = await jobsCollection.find({
        Status: { $in: ['active'] },
        GermanRequired: false
    })
        .sort({ PostedDate: -1, createdAt: -1 })
        .limit(9)
        .project({
            JobTitle: 1, Company: 1, Location: 1, Department: 1,
            PostedDate: 1, ApplicationURL: 1, GermanRequired: 1, applyClicks: 1
        })
        .toArray();
    return jobs.map(job => ({ ...job, applyClicks: job.applyClicks || 0 }));
}

export async function getJobsPaginated(page = 1, limit = 30, filters = {}) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const skip = (page - 1) * limit;

    // ── Base query ────────────────────────────────────────────────────────────
    const query = {
        Status: { $in: ['active'] },
        GermanRequired: false
    };

    // ── Company filter (multi-select array) ───────────────────────────────────
    if (filters.company && filters.company.length > 0) {
        query.Company = { $in: filters.company };
    }

    // ── Category filter (multi-select array) ──────────────────────────────────
    // Validates against the canonical list so we don't accept arbitrary input.
    if (filters.category && filters.category.length > 0) {
        const valid = filters.category.filter(c => ALL_CATEGORIES.includes(c));
        if (valid.length > 0) {
            query.Category = { $in: valid };
        }
    }

    // ── Additional $and conditions (search + date) ────────────────────────────
    const conditions = [];

    // Full-text search across title, company, location
    if (filters.search && filters.search.trim()) {
        const escaped = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        conditions.push({
            $or: [
                { JobTitle: regex },
                { Company: regex },
                { Location: regex }
            ]
        });
    }

    // Date range filter — falls back to scrapedAt when PostedDate is null
    if (filters.date && filters.date !== 'All') {
        const msPerDay = 24 * 60 * 60 * 1000;
        const daysMap = { 'Today': 1, 'This Week': 7, 'This Month': 30 };
        const days = daysMap[filters.date];
        if (days) {
            const cutoff = new Date(Date.now() - days * msPerDay);
            conditions.push({
                $or: [
                    { PostedDate: { $gte: cutoff } },
                    { PostedDate: null,              scrapedAt: { $gte: cutoff } },
                    { PostedDate: { $exists: false }, scrapedAt: { $gte: cutoff } }
                ]
            });
        }
    }

    if (conditions.length > 0) {
        query.$and = conditions;
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    const sortOrder = filters.sort === 'company'
        ? { Company: 1, PostedDate: -1 }
        : { PostedDate: -1, createdAt: -1 };

    // ── Run count + find in parallel ──────────────────────────────────────────
    const [totalJobs, jobs] = await Promise.all([
        jobsCollection.countDocuments(query),
        jobsCollection.find(query)
            .sort(sortOrder)
            .skip(skip)
            .limit(limit)
            .toArray()
    ]);

    const normalizedJobs = jobs.map(job => ({
        ...job,
        applyClicks: job.applyClicks || 0
    }));

    return { jobs: normalizedJobs, totalJobs };
}

/**
 * Returns all distinct active company names, sorted alphabetically.
 * Used to populate the company filter dropdown on the frontend.
 */
export async function getCompanyNames() {
    const db = await connectToDb();
    const names = await db.collection('jobs').distinct('Company', {
        Status: 'active',
        GermanRequired: false
    });
    return names.filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/**
 * Returns job counts per Category, e.g.:
 *   { software: 533, data: 92, product_tech: 53, other_tech: 226, ... }
 * Used to populate the category filter dropdown with counts.
 * Only counts active, non-German-required jobs (same filter as the list endpoint).
 */
export async function getCategoryCounts() {
    const db = await connectToDb();
    const pipeline = [
        { $match: { Status: 'active', GermanRequired: false } },
        { $group: { _id: '$Category', count: { $sum: 1 } } },
    ];
    const results = await db.collection('jobs').aggregate(pipeline).toArray();

    // Build a complete map including zero-count categories so the UI can
    // render every option even when one has no jobs right now.
    const counts = {};
    for (const cat of ALL_CATEGORIES) counts[cat] = 0;
    for (const row of results) {
        if (row._id && counts.hasOwnProperty(row._id)) {
            counts[row._id] = row.count;
        }
    }
    return counts;
}

export async function getRejectedJobs() {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    return await jobsCollection.find({ Status: 'rejected' })
        .sort({ updatedAt: -1 })
        .toArray();
}

export async function getJobsForReview(page = 1, limit = 50) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const skip = (page - 1) * limit;

    const query = { Status: 'pending_review' };

    const totalJobs = await jobsCollection.countDocuments(query);
    const jobs = await jobsCollection.find(query)
        .sort({ ConfidenceScore: -1, scrapedAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

    return {
        jobs,
        totalJobs,
        totalPages: Math.ceil(totalJobs / limit),
        currentPage: page
    };
}

export async function reviewJobDecision(jobId, decision) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    let newStatus = 'pending_review';
    if (decision === 'accept') newStatus = 'active';
    if (decision === 'reject') newStatus = 'rejected';

    await jobsCollection.updateOne(
        { _id: new ObjectId(jobId) },
        {
            $set: {
                Status: newStatus,
                reviewedAt: new Date()
            }
        }
    );
    return { success: true, status: newStatus };
}

export async function trackApplyClick(jobId, visitorId) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const clicksCollection = db.collection('applyClicks');

    if (!ObjectId.isValid(jobId)) {
        throw new Error('Invalid job id');
    }
    if (!visitorId || typeof visitorId !== 'string') {
        throw new Error('visitorId is required');
    }

    const objectId = new ObjectId(jobId);
    const existing = await clicksCollection.findOne({ jobId: objectId, visitorId });

    if (existing) {
        const job = await jobsCollection.findOne({ _id: objectId }, { projection: { applyClicks: 1 } });
        return { applyClicks: job?.applyClicks || 0, alreadyTracked: true };
    }

    try {
        await clicksCollection.insertOne({
            jobId: objectId,
            visitorId,
            clickedAt: new Date()
        });
    } catch (error) {
        if (error?.code === 11000) {
            const job = await jobsCollection.findOne({ _id: objectId }, { projection: { applyClicks: 1 } });
            return { applyClicks: job?.applyClicks || 0, alreadyTracked: true };
        }
        throw error;
    }

    const result = await jobsCollection.findOneAndUpdate(
        { _id: objectId },
        { $inc: { applyClicks: 1 }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after', projection: { applyClicks: 1 } }
    );

    return { applyClicks: result?.applyClicks || 1, alreadyTracked: false };
}

export async function getCompanyDirectoryStats() {
    try {
        const db = await connectToDb();
        const jobsCollection = db.collection('jobs');
        const manualCompaniesCollection = db.collection('manual_companies');

        const now = new Date();
        const sevenDaysAgo  = new Date(now - 7  * 24 * 60 * 60 * 1000);
        const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        // ── Single aggregation that computes everything per company ─────
        const pipeline = [
            {
                $match: {
                    Status: 'active',
                    GermanRequired: false,
                }
            },
            {
                // Compute age & freshness flags per job
                $addFields: {
                    _postedOrCreated: { $ifNull: ['$PostedDate', '$createdAt'] },
                }
            },
            {
                $addFields: {
                    _ageDays: {
                        $divide: [
                            { $subtract: [now, '$_postedOrCreated'] },
                            1000 * 60 * 60 * 24,
                        ]
                    },
                    _isNewThisWeek: { $gte: ['$_postedOrCreated', sevenDaysAgo] },
                    _isLastWeek: {
                        $and: [
                            { $gte: ['$_postedOrCreated', fourteenDaysAgo] },
                            { $lt:  ['$_postedOrCreated', sevenDaysAgo] },
                        ]
                    },
                    _isStale: { $lt: ['$_postedOrCreated', thirtyDaysAgo] },
                }
            },
            {
                $group: {
                    _id: '$Company',
                    totalRoles:    { $sum: 1 },
                    newThisWeek:   { $sum: { $cond: ['$_isNewThisWeek', 1, 0] } },
                    lastWeek:      { $sum: { $cond: ['$_isLastWeek', 1, 0] } },
                    staleCount:    { $sum: { $cond: ['$_isStale', 1, 0] } },
                    avgAgeDays:    { $avg: '$_ageDays' },
                    locations:     { $addToSet: '$Location' },
                    categories:    { $addToSet: '$Category' },
                }
            },
            { $sort: { newThisWeek: -1, totalRoles: -1 } },
        ];

        const scrapedStats = await jobsCollection.aggregate(pipeline).toArray();

        const formattedScraped = scrapedStats.map(stat => {
            const stalePercent = stat.totalRoles > 0
                ? Math.round((stat.staleCount / stat.totalRoles) * 100)
                : 0;

            // ── Badge logic ─────────────────────────────────────
            let badge = 'steady';
            if (stat.newThisWeek >= 5)                badge = 'hiring_fast';
            else if (stat.newThisWeek >= 1)           badge = 'active';
            else if (stalePercent >= 50)              badge = 'possibly_stale';

            return {
                companyName:     stat._id || 'Unknown',
                totalRoles:      stat.totalRoles,
                newThisWeek:     stat.newThisWeek,
                lastWeek:        stat.lastWeek,
                avgAgeDays:      Math.round(stat.avgAgeDays || 0),
                staleCount:      stat.staleCount,
                stalePercent,
                badge,
                wowDelta:        stat.newThisWeek - stat.lastWeek,
                cities: [...new Set(
                    (stat.locations || [])
                        .filter(Boolean)
                        .map(l => l.split(',')[0].trim())
                )].slice(0, 5),
                categories: (stat.categories || []).filter(Boolean),
                source: 'scraped',
            };
        });

        // ── Manual companies (unchanged logic) ──────────────────────────
        const manualCompanies = await manualCompaniesCollection.find({}).toArray();
        const scrapedNames = new Set(formattedScraped.map(c => c.companyName.toLowerCase()));
        const formattedManual = manualCompanies
            .filter(c => !scrapedNames.has((c.name || '').toLowerCase()))
            .map(c => ({
                companyName:   c.name,
                totalRoles:    0,
                newThisWeek:   0,
                lastWeek:      0,
                avgAgeDays:    0,
                staleCount:    0,
                stalePercent:  0,
                badge:         'manual',
                wowDelta:      0,
                cities: c.cities
                    ? (typeof c.cities === 'string' ? c.cities.split(',').map(s => s.trim()) : (Array.isArray(c.cities) ? c.cities : []))
                    : [],
                categories:    [],
                careersUrl:    c.domain || null,
                source:        'manual',
            }));

        // ── Merge: scraped sorted by newThisWeek desc, then manual alpha ──
        return [
            ...formattedScraped,
            ...formattedManual.sort((a, b) => a.companyName.localeCompare(b.companyName)),
        ];
    } catch (error) {
        console.error('Stats: Aggregation failed:', error);
        return [];
    }
}

export async function findJobById(id) {
    const db = await connectToDb();
    return await db.collection('jobs').findOne({ _id: new ObjectId(id) });
}

export async function findJobByIdOrJobID(idOrJobID) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    if (ObjectId.isValid(idOrJobID)) {
        const byObjectId = await jobsCollection.findOne({ _id: new ObjectId(idOrJobID) });
        if (byObjectId) return byObjectId;
    }

    return await jobsCollection.findOne({ JobID: idOrJobID });
}

export async function getJobsEligibleForReanalysis() {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    return await jobsCollection.find({
        Status: { $in: ['pending_review', 'active', 'rejected'] },
        sourceSite: { $ne: 'Curated' }
    }).toArray();
}

export async function countManuallyReviewedJobs() {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    return await jobsCollection.countDocuments({
        $or: [
            { Status: 'active', reviewedAt: { $exists: true, $ne: null } },
            { Status: 'rejected', reviewedAt: { $exists: true, $ne: null } }
        ]
    });
}



export async function updateJobAfterReanalysis(jobId, aiResult, status, rejectionReason, domain, subDomain) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    await jobsCollection.updateOne(
        { _id: new ObjectId(jobId) },
        {
            $set: {
                GermanRequired: aiResult.german_required,
                Domain: domain,
                SubDomain: subDomain,
                ConfidenceScore: aiResult.confidence,
                Evidence: aiResult.evidence || { german_reason: '' },
                Status: status,
                RejectionReason: rejectionReason,
                updatedAt: new Date()
            }
        }
    );

    return await jobsCollection.findOne({ _id: new ObjectId(jobId) });
}



export async function restoreRejectedJobToQueue(jobId) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    await jobsCollection.updateOne(
        { _id: new ObjectId(jobId) },
        {
            $set: {
                Status: 'pending_review',
                RejectionReason: null,
                updatedAt: new Date()
            },
            $unset: {
                reviewedAt: ''
            }
        }
    );
}



export async function deleteJobsByCompany(companyName) {
    const db = await connectToDb();
    console.log(`[Admin] Deleting all jobs for company: ${companyName}`);
    return await db.collection('jobs').deleteMany({
        Company: { $regex: new RegExp(`^${companyName}$`, 'i') }
    });
}

export async function cleanAllDescriptions() {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const logsCollection = db.collection('jobTestLogs');

    let total = 0;
    let cleaned = 0;

    const cleanInCollection = async (collection) => {
        const cursor = collection.find({}, { projection: { _id: 1, Description: 1 } });

        while (await cursor.hasNext()) {
            const document = await cursor.next();
            total += 1;

            const currentDescription = typeof document?.Description === 'string' ? document.Description : '';
            const nextDescription = StripHtml(currentDescription);

            if (nextDescription !== currentDescription) {
                await collection.updateOne(
                    { _id: document._id },
                    { $set: { Description: nextDescription, updatedAt: new Date() } }
                );
                cleaned += 1;
            }
        }
    };

    await cleanInCollection(jobsCollection);
    await cleanInCollection(logsCollection);

    return {
        total,
        cleaned,
        alreadyClean: total - cleaned
    };
}
// ─────────────────────────────────────────────────────────────────────────
// Weekly Digest queries
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fetch all active English-only jobs posted within the last N days,
 * grouped by category (Software, Data, Product Tech, etc).
 *
 * Strategy: ONE query for everyone. The weekly digest cron uses this
 * single result set to build per-user emails by filtering in memory.
 *
 * The Category field is computed at runtime via categorizeJob() because
 * jobs aren't tagged at scrape time. This keeps the function self-contained
 * and avoids a schema migration.
 *
 * @param {number} days       - Look-back window in days (default 7)
 * @param {number} maxPerCat  - Soft cap on jobs returned per category (default 50)
 */
export async function getDigestJobs(days = 7, maxPerCat = 50) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    const sinceDate = new Date(Date.now() - days * 86400000);

    // Fields the email template needs.
    // Now reads the stored Category field (computed at scrape time in saveJobs)
    // instead of recomputing — faster and consistent with /api/jobs filtering.
    const jobs = await jobsCollection
        .find(
            {
                Status: 'active',
                GermanRequired: false,
                PostedDate: { $gte: sinceDate },
            },
            {
                projection: {
                    JobID: 1,
                    JobTitle: 1,
                    Company: 1,
                    Location: 1,
                    EmploymentType: 1,
                    WorkplaceType: 1,
                    IsRemote: 1,
                    SalaryMin: 1,
                    SalaryMax: 1,
                    SalaryCurrency: 1,
                    SalaryInterval: 1,
                    ExperienceLevel: 1,
                    PostedDate: 1,
                    ApplicationURL: 1,
                    Category: 1,
                    applyClicks: 1,
                },
            },
        )
        .sort({ PostedDate: -1 })
        .toArray();

    // Group by stored Category, cap each bucket
    const byCategory = {};
    for (const job of jobs) {
        const cat = job.Category || 'other_tech';
        if (!byCategory[cat]) byCategory[cat] = [];
        if (byCategory[cat].length < maxPerCat) {
            byCategory[cat].push(job);
        }
    }

    return { byCategory, total: jobs.length };
}