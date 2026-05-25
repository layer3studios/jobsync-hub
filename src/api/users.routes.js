import { Router } from 'express';

const router = Router();


// GET /api/users — legacy endpoint, now returns 410 Gone
router.get('/', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// POST /api/users — legacy endpoint, now returns 410 Gone
router.post('/', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// PATCH /api/users/:slug/visit — legacy endpoint, returns 410 Gone
router.patch('/:slug/visit', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// GET /api/users/:slug/applied — legacy endpoint, returns 410 Gone
router.get('/:slug/applied', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// GET /api/users/:slug/applied/details — legacy endpoint, returns 410 Gone
router.get('/:slug/applied/details', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// POST /api/users/:slug/applied/:jobId — legacy endpoint, returns 410 Gone
router.post('/:slug/applied/:jobId', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// DELETE /api/users/:slug/applied/:jobId — legacy endpoint, returns 410 Gone
router.delete('/:slug/applied/:jobId', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// PUT /api/users/:slug/skills — legacy endpoint, returns 410 Gone
router.put('/:slug/skills', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// PATCH /api/users/:slug/skills — legacy endpoint, returns 410 Gone
router.patch('/:slug/skills', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// GET /api/users/:slug/comeback — legacy endpoint, returns 410 Gone
router.get('/:slug/comeback', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// POST /api/users/:slug/comeback/:jobId — legacy endpoint, returns 410 Gone
router.post('/:slug/comeback/:jobId', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// DELETE /api/users/:slug/comeback/:jobId — legacy endpoint, returns 410 Gone
router.delete('/:slug/comeback/:jobId', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// PATCH /api/users/:slug/goal — legacy endpoint, returns 410 Gone
router.patch('/:slug/goal', (_req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

// GET /api/users/:slug — full user data
// GET /api/users/:slug — full user data
router.get('/:slug', async (req, res) => {
    res.status(410).json({ error: 'Legacy endpoint. Use Google login.' });
});

export default router;
