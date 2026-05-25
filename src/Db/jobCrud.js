import { ObjectId } from 'mongodb';
import { connectToDb } from './connection.js';
import { SITES_CONFIG } from '../config.js';
import { createJobModel } from '../models/jobModel.js';
import { cleanJobDescription } from '../core/cleanJobDescription.js';
import { generateJobTags, getPlainTextForTagging } from '../core/generateJobTags.js';

export async function deleteExpiredJobs(siteName, seenJobIds) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    // seenJobIds is a Set of all JobID strings found in the current scrape
    // Any job in DB for this site whose JobID is NOT in this set has been removed from the ATS
    const seenArray = Array.from(seenJobIds);

    const result = await jobsCollection.deleteMany({
        sourceSite: siteName,
        JobID: { $nin: seenArray }
    });

    if (result.deletedCount > 0) {
        console.log(`[${siteName}] Deleted ${result.deletedCount} expired jobs (no longer on ATS).`);
    }
}

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

    const dedupedJobs = [];
    const seenJobIds = new Set();
    for (const job of jobs) {
        if (!job?.JobID || seenJobIds.has(job.JobID)) continue;
        seenJobIds.add(job.JobID);
        dedupedJobs.push(job);
    }

    const operations = dedupedJobs.map(inputJob => {
        const job = { ...inputJob };

        if (job.Description) {
            job.DescriptionCleaned = cleanJobDescription(job.Description, job.Company);
            job.DescriptionPlain = getPlainTextForTagging(job);
            const autoTags = generateJobTags(job);
            job.autoTags = autoTags;
            job.isEntryLevel = autoTags.isEntryLevel;
        }

        const { createdAt, updatedAt, ...pureJobData } = job;
        return {
            updateOne: {
                filter: { JobID: job.JobID },
                update: {
                    $setOnInsert: {
                        ...pureJobData,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        scrapedAt: new Date()
                    }
                },
                upsert: true,
            },
        };
    });

    if (operations.length === 0) return;
    await jobsCollection.bulkWrite(operations, { ordered: false });
}

export async function saveJobTestLog(jobTestLog) {
    if (!jobTestLog) return;
    const db = await connectToDb();
    const testLogsCollection = db.collection('jobTestLogs');

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

export async function deleteOldJobs(siteName, scrapeStartTime) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const result = await jobsCollection.deleteMany({
        sourceSite: siteName,
        updatedAt: { $lt: sevenDaysAgo }
    });

    if (result.deletedCount > 0) {
        console.log(`[${siteName}] Deleted ${result.deletedCount} jobs older than 7 days.`);
    }
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
        Status: 'active'
    })
        .sort({ PostedDate: -1, createdAt: -1 })
        .limit(9)
        .project({
            JobTitle: 1, Company: 1, Location: 1, Department: 1,
            PostedDate: 1, ApplicationURL: 1
        })
        .toArray();
    return jobs;
}

export async function getJobsPaginated(
    page = 1,
    limit = 50,
    companyFilter = null,
    platformFilter = null,
    workplaceFilter = null,
    entryLevelFilter = null,
    roleCategoryFilter = null,
    experienceBandFilter = null,
    techStackFilter = [],
    dateFilter = null,
    searchFilter = null,
) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const skip = (page - 1) * limit;

    // ── Base: only active jobs ──────────────────────────────────────────────
    const must = [{ Status: 'active' }];

    // ── Company ─────────────────────────────────────────────────────────────
    if (companyFilter && companyFilter.trim()) {
        must.push({ Company: { $regex: companyFilter.trim(), $options: 'i' } });
    }

    // ── ATS Platform ────────────────────────────────────────────────────────
    if (platformFilter && platformFilter.trim()) {
        must.push({ ATSPlatform: platformFilter.trim().toLowerCase() });
    }

    // ── Remote / Workplace ──────────────────────────────────────────────────
    if (workplaceFilter && workplaceFilter.trim()) {
        const workplace = workplaceFilter.trim().toLowerCase();

        if (workplace === 'remote') {
            must.push({
                $or: [
                    { WorkplaceType: { $regex: '^remote$', $options: 'i' } },
                    { Location: { $regex: 'remote', $options: 'i' } },
                    { JobTitle: { $regex: 'remote', $options: 'i' } },
                    { IsRemote: true },
                ],
            });
        } else if (workplace === 'hybrid') {
            must.push({
                $or: [
                    { WorkplaceType: { $regex: '^hybrid(?: job)?$', $options: 'i' } },
                    { Location: { $regex: 'hybrid', $options: 'i' } },
                    { JobTitle: { $regex: 'hybrid', $options: 'i' } },
                ],
            });
        } else if (workplace === 'on-site') {
            must.push({
                $or: [
                    { WorkplaceType: { $regex: '^(?:on-site|onsite|onsite job)$', $options: 'i' } },
                    { Location: { $regex: 'on.?site|in-office', $options: 'i' } },
                    { JobTitle: { $regex: 'on.?site|in-office', $options: 'i' } },
                ],
            });
        }
    }

    // ── Role Category ────────────────────────────────────────────────────────
    if (roleCategoryFilter && roleCategoryFilter.trim()) {
        must.push({ 'autoTags.roleCategory': roleCategoryFilter.trim() });
    }

    // ── Experience Band ──────────────────────────────────────────────────────
    if (experienceBandFilter && experienceBandFilter.trim()) {
        const isFresher =
            experienceBandFilter === 'Fresher (0-1y)' ||
            experienceBandFilter === 'fresher' ||
            experienceBandFilter === 'Entry Level';

        if (isFresher) {
            must.push({
                $or: [
                    { 'autoTags.experienceBand': experienceBandFilter.trim() },
                    { isEntryLevel: true },
                ],
            });
        } else {
            must.push({ 'autoTags.experienceBand': experienceBandFilter.trim() });
        }
    } else if (entryLevelFilter) {
        must.push({
            $or: [
                { isEntryLevel: true },
                { 'autoTags.experienceBand': 'Fresher (0-1y)' },
            ],
        });
    }

    // ── Tech Stack ───────────────────────────────────────────────────────────
    if (Array.isArray(techStackFilter) && techStackFilter.length > 0) {
        const cleanedStack = techStackFilter.map(t => t.trim()).filter(Boolean);
        if (cleanedStack.length > 0) {
            must.push({ 'autoTags.techStack': { $all: cleanedStack } });
        }
    }

    // ── Date Filter ──────────────────────────────────────────────────────────
    if (dateFilter) {
        const daysMap = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 };
        const days = daysMap[dateFilter];
        if (days) {
            const since = new Date(Date.now() - days * 86400000);
            must.push({ PostedDate: { $gte: since } });
        }
    }

    // ── Full-text search ─────────────────────────────────────────────────────
    if (searchFilter && searchFilter.trim().length >= 2) {
        const escaped = searchFilter.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = { $regex: escaped, $options: 'i' };
        must.push({
            $or: [
                { JobTitle: re },
                { Company: re },
                { Location: re },
                { 'autoTags.techStack': re },
                { Department: re },
            ],
        });
    }

    // ── Compose final query ──────────────────────────────────────────────────
    const query = must.length === 1 ? must[0] : { $and: must };

    const [totalJobs, jobs, companies] = await Promise.all([
        jobsCollection.countDocuments(query),
        jobsCollection.find(query)
            .sort({ PostedDate: -1, scrapedAt: -1 })
            .skip(skip)
            .limit(limit)
            .project({ __v: 0 })
            .toArray(),
        jobsCollection.distinct('Company', { Status: 'active' }),
    ]);

    return {
        jobs,
        totalJobs,
        totalPages: Math.ceil(totalJobs / limit),
        currentPage: page,
        companies,
    };
}

export async function findJobById(id) {
    const db = await connectToDb();
    return await db.collection('jobs').findOne({ _id: new ObjectId(id) });
}
