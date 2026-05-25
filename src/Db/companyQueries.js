import { ObjectId } from 'mongodb';
import { connectToDb } from './connection.js';

export async function getCompanyDirectoryStats() {
    try {
        const db = await connectToDb();

        const jobsCollection = db.collection('jobs');

        const pipeline = [
            {
                $match: {
                    Status: 'active'
                }
            },
            {
                $group: {
                    _id: "$Company",
                    openRoles: { $sum: 1 },
                    locations: { $addToSet: "$Location" },
                    sampleUrl: { $first: "$ApplicationURL" }
                }
            },
            { $sort: { openRoles: -1 } }
        ];
        const scrapedStats = await jobsCollection.aggregate(pipeline).toArray();

        const formattedScraped = scrapedStats.map(stat => ({
            _id: stat._id,
            companyName: stat._id || "Unknown",
            openRoles: stat.openRoles,
            cities: [...new Set((stat.locations || []).map(l => l.split(',')[0].trim()))].slice(0, 2),
            domain: stat._id.toLowerCase().replace(/[^a-z0-9-]/g, '') + ".com",
            source: 'scraped'
        }));

        const manualCollection = db.collection('manual_companies');
        const manualCompanies = await manualCollection.find({}).toArray();

        const formattedManual = manualCompanies.map(c => ({
            _id: c._id.toString(),
            companyName: c.name,
            openRoles: 0,
            cities: c.cities ? c.cities.split(',').map(s => s.trim()) : [],
            domain: c.domain,
            source: 'manual'
        }));

        const scrapedNames = new Set(formattedScraped.map(c => c.companyName.toLowerCase()));
        const uniqueManual = formattedManual.filter(c => !scrapedNames.has(c.companyName.toLowerCase()));

        return [...formattedScraped, ...uniqueManual];

    } catch (error) {
        console.error("Stats: Aggregation failed:", error);
        return [];
    }
}

export async function deleteJobsByCompany(companyName) {
    const db = await connectToDb();
    console.log(`[Admin] Deleting all jobs for company: ${companyName}`);
    return await db.collection('jobs').deleteMany({
        Company: { $regex: new RegExp(`^${companyName}$`, 'i') }
    });
}

export async function addManualCompany(data) {
    const db = await connectToDb();
    const companiesCollection = db.collection('manual_companies');

    const exists = await companiesCollection.findOne({
        name: { $regex: new RegExp(`^${data.name}$`, 'i') }
    });
    if (exists) throw new Error("Company already exists in manual list.");

    await companiesCollection.insertOne({
        ...data,
        createdAt: new Date()
    });
}

export async function deleteManualCompany(id) {
    const db = await connectToDb();
    const companiesCollection = db.collection('manual_companies');
    await companiesCollection.deleteOne({ _id: new ObjectId(id) });
}

// ─── Company Intel (1-hour in-memory cache) ────────────────────────
const companyIntelCache = new Map();

export async function getCompanyIntel(companyName) {
    // Guard: empty or non-string input
    if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
        return {
            companyName: '', totalOpenRoles: 0, newRolesThisWeek: 0, newRolesLastWeek: 0,
            avgRoleAgeDays: 0, oldestRoleDays: 0, newestRoleDays: 0, hiringTrend: 'stable',
            peakPostingDay: null, busiestDays: [], postingDayDistribution: [0, 0, 0, 0, 0, 0, 0]
        };
    }
    const cacheKey = companyName.trim().toLowerCase();
    const cached = companyIntelCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < 3600000) return cached.data;

    const db = await connectToDb();
    const jobsCollection = db.collection('jobs');
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 86400000);
    const fourteenDaysAgo = new Date(now - 14 * 86400000);

    const escapedName = companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const jobs = await jobsCollection.find(
        { Company: { $regex: new RegExp(`^${escapedName}$`, 'i') }, Status: 'active' },
        { projection: { PostedDate: 1, createdAt: 1, scrapedAt: 1 } }
    ).toArray();

    const totalOpenRoles = jobs.length;
    const newRolesThisWeek = jobs.filter(j => new Date(j.createdAt || j.scrapedAt) >= sevenDaysAgo).length;
    const newRolesLastWeek = jobs.filter(j => {
        const d = new Date(j.createdAt || j.scrapedAt);
        return d >= fourteenDaysAgo && d < sevenDaysAgo;
    }).length;

    const ages = jobs.map(j => Math.floor((now - new Date(j.PostedDate || j.createdAt || j.scrapedAt)) / 86400000)).filter(a => Number.isFinite(a) && a >= 0);
    const avgRoleAgeDays = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
    const oldestRoleDays = ages.length > 0 ? Math.max(...ages) : 0;
    const newestRoleDays = ages.length > 0 ? Math.min(...ages) : 0;

    let hiringTrend = 'stable';
    if (newRolesThisWeek > newRolesLastWeek) hiringTrend = 'up';
    else if (newRolesThisWeek < newRolesLastWeek) hiringTrend = 'down';

    const dayCounts = [0, 0, 0, 0, 0, 0, 0];
    for (const job of jobs) {
        const posted = new Date(job.PostedDate || job.createdAt || job.scrapedAt);
        if (!isNaN(posted.getTime())) dayCounts[posted.getDay()]++;
    }
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayPairs = dayCounts.map((count, i) => ({ day: dayNames[i], count }));
    dayPairs.sort((a, b) => b.count - a.count);
    const busiestDays = dayPairs.filter(d => d.count > 0).slice(0, 3).map(d => d.day);

    const data = {
        companyName: companyName.trim(), totalOpenRoles, newRolesThisWeek, newRolesLastWeek,
        avgRoleAgeDays, oldestRoleDays, newestRoleDays, hiringTrend,
        peakPostingDay: busiestDays[0] || null, busiestDays,
        postingDayDistribution: dayCounts,
    };
    companyIntelCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
}
