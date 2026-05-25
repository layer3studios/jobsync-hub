import { ObjectId } from 'mongodb';
import { connectToDb } from './connection.js';

// ─── Similar Jobs ───────────────────────────────────────────────────
export async function getSimilarJobs(jobId) {
    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    let oid;
    try { oid = new ObjectId(jobId); } catch { return []; }

    const job = await jobsCollection.findOne({ _id: oid }, { projection: { Company: 1, autoTags: 1 } });
    if (!job) return [];

    // Build query — always filter by different company; match tags when available
    const query = { _id: { $ne: oid }, Status: 'active', Company: { $ne: job.Company || '' } };
    if (job.autoTags?.roleCategory) query['autoTags.roleCategory'] = job.autoTags.roleCategory;
    if (job.autoTags?.experienceBand) query['autoTags.experienceBand'] = job.autoTags.experienceBand;

    const results = await jobsCollection.find(query)
        .sort({ createdAt: -1, PostedDate: -1 })
        .limit(8)
        .project({ JobTitle: 1, Company: 1, Location: 1, ApplicationURL: 1, PostedDate: 1, autoTags: 1, scrapedAt: 1 })
        .toArray();

    // Fallback: if no tagged matches exist, return recent active jobs from other companies
    if (results.length === 0) {
        return jobsCollection.find({ _id: { $ne: oid }, Status: 'active', Company: { $ne: job.Company || '' } })
            .sort({ createdAt: -1 })
            .limit(8)
            .project({ JobTitle: 1, Company: 1, Location: 1, ApplicationURL: 1, PostedDate: 1, autoTags: 1, scrapedAt: 1 })
            .toArray();
    }
    return results;
}

// ─── Market Pulse (6-hour in-memory cache) ──────────────────────────
let marketPulseCache = null;

export async function getMarketPulse() {
    if (marketPulseCache && (Date.now() - marketPulseCache.timestamp) < 21600000) return marketPulseCache.data;

    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 86400000);
    const fourteenDaysAgo = new Date(now - 14 * 86400000);

    let currentCounts, thisWeekCounts, lastWeekCounts;
    try {
        [currentCounts, thisWeekCounts, lastWeekCounts] = await Promise.all([
            jobsCollection.aggregate([
                { $match: { Status: 'active', 'autoTags.roleCategory': { $exists: true, $ne: null, $type: 'string' } } },
                { $group: { _id: '$autoTags.roleCategory', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray(),
            jobsCollection.aggregate([
                { $match: { Status: 'active', createdAt: { $gte: sevenDaysAgo }, 'autoTags.roleCategory': { $exists: true, $type: 'string' } } },
                { $group: { _id: '$autoTags.roleCategory', count: { $sum: 1 } } }
            ]).toArray(),
            jobsCollection.aggregate([
                { $match: { Status: 'active', createdAt: { $gte: fourteenDaysAgo, $lte: sevenDaysAgo }, 'autoTags.roleCategory': { $exists: true, $type: 'string' } } },
                { $group: { _id: '$autoTags.roleCategory', count: { $sum: 1 } } }
            ]).toArray(),
        ]);
    } catch (err) {
        console.error('[getMarketPulse] aggregation failed:', err);
        // Return stale cache if available rather than crashing
        if (marketPulseCache) return marketPulseCache.data;
        return { categories: [], totalJobs: 0, updatedAt: now.toISOString() };
    }

    const thisWeekMap = new Map(thisWeekCounts.map(r => [r._id, r.count]));
    const lastWeekMap = new Map(lastWeekCounts.map(r => [r._id, r.count]));

    const categories = currentCounts
        .filter(cat => cat._id && typeof cat._id === 'string')
        .map(cat => {
            const tw = thisWeekMap.get(cat._id) || 0;
            const lw = lastWeekMap.get(cat._id) || 0;
            let trendPercent = lw > 0 ? Math.round(((tw - lw) / lw) * 100) : (tw > 0 ? 100 : 0);
            // Cap extreme values for display
            trendPercent = Math.max(-200, Math.min(200, trendPercent));
            const trend = trendPercent > 5 ? 'up' : trendPercent < -5 ? 'down' : 'stable';
            return { category: cat._id, totalRoles: cat.count, newThisWeek: tw, trendPercent, trend };
        });

    const totalJobs = categories.reduce((sum, c) => sum + c.totalRoles, 0);
    const data = { categories, totalJobs, updatedAt: now.toISOString() };
    marketPulseCache = { data, timestamp: Date.now() };
    return data;
}

// ─── Hiring Leaderboard (1-hour in-memory cache) ────────────────────────────
// "Who's Actually Hiring Right Now" — a public, shareable leaderboard.
//
// Data signals:
//   createdAt  — when our scraper FIRST inserted this job (= "new to us")
//   scrapedAt  — last time the scraper confirmed the job still exists on the ATS
//   PostedDate — the date the company says they posted it (can be null, stale, or backdated)
//   Status     — 'active' for live jobs
//
// Edge cases handled:
//   1. Company name variations (case-insensitive grouping via $toLower)
//   2. Companies with only 1 stale job (excluded — not a real hiring signal)
//   3. PostedDate is null or far in the past (fall back to createdAt)
//   4. Jobs that disappeared between scrapes (deleteExpiredJobs already handles this)
//   5. Week-over-week uses createdAt, not PostedDate (PostedDate is often backdated)
//   6. "Stale ratio" — % of jobs older than 30 days — exposes resume collectors
//   7. Zero new roles this week still shows (with delta = 0) for complete picture

let hiringLeaderboardCache = null;

export async function getHiringLeaderboard() {
    if (hiringLeaderboardCache && (Date.now() - hiringLeaderboardCache.timestamp) < 3600000) {
        return hiringLeaderboardCache.data;
    }

    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 86400000);
    const fourteenDaysAgo = new Date(now - 14 * 86400000);
    const thirtyDaysAgo = new Date(now - 30 * 86400000);

    try {
        const pipeline = [
            { $match: { Status: 'active' } },
            {
                $addFields: {
                    _effectiveDate: { $ifNull: ['$createdAt', '$scrapedAt'] },
                    _postedOrCreated: {
                        $ifNull: ['$PostedDate', { $ifNull: ['$createdAt', '$scrapedAt'] }]
                    },
                }
            },
            {
                $group: {
                    _id: { $toLower: '$Company' },
                    displayName: { $first: '$Company' },
                    totalActiveRoles: { $sum: 1 },

                    newThisWeek: {
                        $sum: {
                            $cond: [{ $gte: ['$_effectiveDate', sevenDaysAgo] }, 1, 0]
                        }
                    },

                    newLastWeek: {
                        $sum: {
                            $cond: [
                                { $and: [
                                    { $gte: ['$_effectiveDate', fourteenDaysAgo] },
                                    { $lt: ['$_effectiveDate', sevenDaysAgo] },
                                ]},
                                1, 0
                            ]
                        }
                    },

                    staleRoles: {
                        $sum: {
                            $cond: [{ $lt: ['$_postedOrCreated', thirtyDaysAgo] }, 1, 0]
                        }
                    },

                    locations: { $addToSet: '$Location' },
                    roleCategories: { $addToSet: '$autoTags.roleCategory' },

                    avgAgeDays: {
                        $avg: {
                            $divide: [
                                { $subtract: [now, '$_postedOrCreated'] },
                                86400000,
                            ]
                        }
                    },

                    mostRecentJobDate: { $max: '$_effectiveDate' },
                }
            },
            // Only include companies with at least 2 active roles
            { $match: { totalActiveRoles: { $gte: 2 } } },
            { $sort: { newThisWeek: -1, totalActiveRoles: -1 } },
        ];

        const raw = await jobsCollection.aggregate(pipeline).toArray();

        const companies = raw.map((c, index) => {
            const staleRatio = c.totalActiveRoles > 0
                ? Math.round((c.staleRoles / c.totalActiveRoles) * 100)
                : 0;

            const delta = c.newThisWeek - c.newLastWeek;
            let trend = 'stable';
            if (delta > 0) trend = 'up';
            else if (delta < 0) trend = 'down';

            let hiringSignal = 'steady';
            if (c.newThisWeek >= 5) hiringSignal = 'hot';
            else if (c.newThisWeek >= 1) hiringSignal = 'active';
            else if (staleRatio > 50) hiringSignal = 'stale';

            const cities = [...new Set(
                (c.locations || [])
                    .filter(l => l && l !== 'N/A')
                    .map(l => l.split(',')[0].trim())
            )].slice(0, 3);

            const topRoles = (c.roleCategories || [])
                .filter(r => r && r !== 'Other' && r !== 'null')
                .slice(0, 4);

            return {
                rank: index + 1,
                company: c.displayName || c._id,
                totalActiveRoles: c.totalActiveRoles,
                newThisWeek: c.newThisWeek,
                newLastWeek: c.newLastWeek,
                delta,
                trend,
                hiringSignal,
                staleRoles: c.staleRoles,
                staleRatio,
                avgAgeDays: Math.round(c.avgAgeDays || 0),
                cities,
                topRoles,
                mostRecentJobDate: c.mostRecentJobDate,
            };
        });

        const totalCompanies = companies.length;
        const totalActiveJobs = companies.reduce((s, c) => s + c.totalActiveRoles, 0);
        const totalNewThisWeek = companies.reduce((s, c) => s + c.newThisWeek, 0);
        const totalNewLastWeek = companies.reduce((s, c) => s + c.newLastWeek, 0);
        const hotCompanies = companies.filter(c => c.hiringSignal === 'hot').length;
        const staleCompanies = companies.filter(c => c.hiringSignal === 'stale').length;

        const data = {
            companies,
            summary: {
                totalCompanies,
                totalActiveJobs,
                totalNewThisWeek,
                totalNewLastWeek,
                weekOverWeekDelta: totalNewThisWeek - totalNewLastWeek,
                hotCompanies,
                staleCompanies,
            },
            updatedAt: now.toISOString(),
        };

        hiringLeaderboardCache = { data, timestamp: Date.now() };
        return data;

    } catch (error) {
        console.error('[getHiringLeaderboard] aggregation failed:', error);
        if (hiringLeaderboardCache) return hiringLeaderboardCache.data;
        return { companies: [], summary: {}, updatedAt: now.toISOString() };
    }
}
