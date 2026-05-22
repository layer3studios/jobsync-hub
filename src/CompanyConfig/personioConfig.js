import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import { StripHtml, SanitizeHtml } from '../utils.js';
import { isIndiaString, normalizeWorkplaceType, normalizeEmploymentType } from '../core/Locationprefilters.js';
import { normalizeArray } from '../core/jobExtractor.js';

// ─── Seniority mapping (Personio → JobMesh ExperienceLevel) ───────────────
const SENIORITY_MAP = {
    'student':       'Entry Level',
    'entry-level':   'Entry Level',
    'experienced':   'Mid Level',
    'lead':          'Senior',
    'senior':        'Senior',
    'manager':       'Manager',
    'director':      'Leadership',
    'executive':     'Leadership',
};

// ─── Schedule mapping ─────────────────────────────────────────────────────
const SCHEDULE_MAP = {
    'full-time': 'Full-time',
    'part-time': 'Part-time',
};

// ─── XML parser config ────────────────────────────────────────────────────
// Personio quirk: a feed with 1 job returns <position> as object, multi-job
// returns an array. Same for jobDescription. Force these to always be arrays.
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ['position', 'jobDescription'].includes(name),
});

// ─── Description assembly ────────────────────────────────────────────────
// Personio splits descriptions into named sections (Intro / Your tasks /
// Your profile / Benefits). We concatenate them with section headers
// preserved so the autoTags generator + frontend get the full context.
function assembleDescription(jobDescriptionsBlock, asHtml) {
    const sections = jobDescriptionsBlock?.jobDescription || [];
    if (!Array.isArray(sections) || sections.length === 0) return '';

    if (asHtml) {
        return sections
            .map(s => `<h3>${s.name || ''}</h3>${s.value || ''}`)
            .join('\n');
    }
    return sections
        .map(s => `${s.name || ''}\n${StripHtml(s.value || '')}`)
        .join('\n\n');
}

export const personioConfig = {
    siteName: "Personio Jobs",
    baseUrl: null, // not used — each company has its own subdomain

    // ─── Company targets ──────────────────────────────────────────────────
    // European companies with India offices that post India roles on Personio.
    // Format: https://{subdomain}.jobs.personio.{tld}/xml?language=en
    //
    // HOW TO FIND MORE:
    // 1. Google: site:*.jobs.personio.de "India" OR "Bangalore" OR "Hyderabad"
    // 2. Or: site:*.jobs.personio.com "India" OR "Mumbai" OR "Pune"
    // 3. Hit the XML feed: https://{subdomain}.jobs.personio.{tld}/xml?language=en
    // 4. If any <office> contains an Indian city name, add it here.
    companyTargets: [
        // European companies known to post India/Remote-India roles
        { subdomain: 'delivery-hero',       tld: 'de' },
        { subdomain: 'hellofresh',          tld: 'de' },
        { subdomain: 'agile-robots-se',     tld: 'de' },
        { subdomain: 'personio',            tld: 'de' },
        { subdomain: 'scalable-gmbh',       tld: 'de' },
        { subdomain: 'celonis',             tld: 'de' },
        { subdomain: 'contentful',          tld: 'de' },
        { subdomain: 'adjust',              tld: 'de' },
        { subdomain: 'sennder',             tld: 'de' },
        { subdomain: 'zalando',             tld: 'de' },
        { subdomain: 'data4life',           tld: 'de' },
        { subdomain: 'studysmarter',        tld: 'de' },
        { subdomain: 'tech11',              tld: 'de' },
        { subdomain: 'aignostics',          tld: 'de' },
        { subdomain: 'robco',               tld: 'de' },
        { subdomain: 'carbmee',             tld: 'com' },
        { subdomain: 'pitch',               tld: 'de' },
        { subdomain: 'socialhub',           tld: 'de' },
    ],

    // Internal state
    _allJobsQueue: [],
    _initialized: false,

    // ─── Initialize: fetch all XML feeds upfront ──────────────────────────
    async initialize() {
        if (this._initialized) return;

        console.log(`[Personio] Fetching jobs from ${this.companyTargets.length} companies...`);

        let successCount = 0;
        let failCount = 0;

        for (const target of this.companyTargets) {
            const { subdomain, tld } = target;
            const url = `https://${subdomain}.jobs.personio.${tld}/xml?language=en`;

            try {
                const response = await fetch(url, {
                    headers: { 'Accept': 'application/xml,text/xml' },
                });

                if (!response.ok) {
                    failCount++;
                    continue;
                }

                const xmlText = await response.text();
                const parsed = xmlParser.parse(xmlText);
                const positions = parsed?.['workzag-jobs']?.position || [];

                if (positions.length === 0) {
                    continue;
                }

                // Filter to India jobs only
                const indiaJobs = positions
                    .filter(job => this.isIndiaJob(job))
                    .map(job => ({
                        ...job,
                        _subdomain: subdomain,
                        _tld: tld,
                    }));

                if (indiaJobs.length > 0) {
                    console.log(`[Personio] ✅ ${subdomain}: ${indiaJobs.length} jobs in India (${positions.length} total)`);
                    this._allJobsQueue.push(...indiaJobs);
                    successCount++;
                }

                // Rate limit: 500ms between companies
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (error) {
                failCount++;
                console.error(`[Personio] ❌ ${subdomain}: ${error.message}`);
            }
        }

        console.log(`[Personio] 📊 Summary: ${successCount} companies with India jobs, ${failCount} failed`);
        console.log(`[Personio] 💼 Total jobs found: ${this._allJobsQueue.length}`);
        this._initialized = true;
    },

    // ─── Required by scraperEngine ────────────────────────────────────────
    async fetchPage(offset, limit) {
        if (!this._initialized) await this.initialize();
        const jobs = this._allJobsQueue.slice(offset, offset + limit);
        return { jobs, total: this._allJobsQueue.length };
    },

    getJobs(data) { return data.jobs || []; },
    getTotal(data) { return data.total || 0; },

    // ─── India detection ──────────────────────────────────────────────────
    isIndiaJob(job) {
        const offices = this.collectAllOffices(job);
        return offices.some(loc => isIndiaString(loc));
    },

    // ─── Helpers ──────────────────────────────────────────────────────────
    collectAllOffices(job) {
        const offices = [];
        if (job.office) offices.push(job.office);
        const extras = job.additionalOffices?.office;
        if (Array.isArray(extras)) {
            offices.push(...extras);
        } else if (typeof extras === 'string' && extras) {
            offices.push(extras);
        }
        return offices;
    },

    // ─── Field extractors ─────────────────────────────────────────────────
    extractJobID(job) {
        return `personio_${job._subdomain}_${job.id}`;
    },

    extractJobTitle(job) {
        return job.name || '';
    },

    extractCompany(job) {
        if (job.subcompany) return job.subcompany;
        return String(job._subdomain || '')
            .split(/[-_]/)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
    },

    extractLocation(job) {
        return job.office || 'India';
    },

    extractDescription(job) {
        return assembleDescription(job.jobDescriptions, false);
    },

    extractDescriptionHtml(job) {
        return SanitizeHtml(assembleDescription(job.jobDescriptions, true));
    },

    extractURL(job) {
        return `https://${job._subdomain}.jobs.personio.${job._tld}/job/${job.id}?language=en`;
    },

    extractPostedDate(job) {
        return job.createdAt || null;
    },
};
