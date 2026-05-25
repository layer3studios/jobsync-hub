import { Router } from 'express';
import { ObjectId } from 'mongodb';
import {
    getJobsPaginated,
    addCuratedJob,
    deleteJobById,
    getPublicBaitJobs,
    getCompanyDirectoryStats,
    findJobById,
    getCompanyIntel,
    getSimilarJobs,
    getMarketPulse,
    getHiringLeaderboard,
} from '../Db/databaseManager.js';

export const jobsApiRouter = Router();

// ---------------------------------------------------------
// PUBLIC ROUTES  — NOTE: specific paths must come before /:id
// ---------------------------------------------------------

jobsApiRouter.get('/public-bait', async (req, res) => {
    try {
        const jobs = await getPublicBaitJobs();
        res.status(200).json(jobs);
    } catch (error) {
        res.status(500).json({ error: "Failed to load bait jobs" });
    }
});

jobsApiRouter.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const company = req.query.company?.trim() || null;
        const platform = req.query.platform?.trim()?.toLowerCase() || null;
        const workplace = req.query.workplace?.trim()?.toLowerCase()
            || (req.query.remote === 'true' ? 'remote' : null);
        const entryLevel = req.query.entryLevel === 'true' ? true : null;
        const roleCategory = req.query.roleCategory?.trim() || null;
        const experienceBand = req.query.experienceBand?.trim() || null;
        const techStack = typeof req.query.techStack === 'string'
            ? req.query.techStack.split(',').map(tag => tag.trim()).filter(Boolean)
            : [];
        // New: date range (1d | 3d | 7d | 30d) and free-text search
        const dateFilter = req.query.date?.trim() || null;
        const searchFilter = req.query.search?.trim() || null;

        const data = await getJobsPaginated(
            page, limit, company, platform, workplace, entryLevel,
            roleCategory, experienceBand, techStack,
            dateFilter, searchFilter,
        );
        res.status(200).json(data);
    } catch (error) {
        console.error('[GET /jobs]', error);
        res.status(500).json({ error: "Failed to fetch jobs" });
    }
});

jobsApiRouter.get('/directory', async (req, res) => {
    try {
        const directory = await getCompanyDirectoryStats();
        res.status(200).json(directory);
    } catch (error) {
        res.status(500).json({ error: "Failed to load directory" });
    }
});

// GET /market-pulse — role category trends (6-hour cache)
jobsApiRouter.get('/market-pulse', async (req, res) => {
    try {
        const data = await getMarketPulse();
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch market pulse' });
    }
});

// GET /company-intel/:companyName — hiring intelligence (1-hour cache)
jobsApiRouter.get('/company-intel/:companyName', async (req, res) => {
    try {
        const data = await getCompanyIntel(decodeURIComponent(req.params.companyName));
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch company intel' });
    }
});

// GET /similar/:jobId — similar jobs at other companies
jobsApiRouter.get('/similar/:jobId', async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.jobId)) return res.status(400).json({ error: 'Invalid ID' });
        const jobs = await getSimilarJobs(req.params.jobId);
        res.status(200).json(jobs);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch similar jobs' });
    }
});

// GET /hiring-leaderboard — public "Who's Actually Hiring" leaderboard (1-hour cache)
jobsApiRouter.get('/hiring-leaderboard', async (req, res) => {
    try {
        const data = await getHiringLeaderboard();
        res.set('Cache-Control', 'public, max-age=1800, s-maxage=3600');
        res.status(200).json(data);
    } catch (error) {
        console.error('[GET /hiring-leaderboard]', error);
        res.status(500).json({ error: 'Failed to fetch hiring leaderboard' });
    }
});

// GET /:id — must be after all named paths
jobsApiRouter.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });
        const job = await findJobById(id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.status(200).json(job);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch job' });
    }
});

jobsApiRouter.post('/', async (req, res) => {
    try {
        const jobData = req.body;
        const newJob = await addCuratedJob(jobData);
        res.status(201).json(newJob);
    } catch (error) {
        if (error.message.includes('duplicate URL')) return res.status(409).json({ error: error.message });
        res.status(500).json({ error: error.message });
    }
});

jobsApiRouter.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid ID' });
        await deleteJobById(new ObjectId(id));
        res.status(200).json({ message: 'Job deleted.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});