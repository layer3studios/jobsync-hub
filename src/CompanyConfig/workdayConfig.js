import fetch from 'node-fetch';
import { StripHtml } from '../utils.js';

const companyBoards = [
    // ── HIGH VOLUME (100+ India jobs) ───────────────────────────────────────
    { company: 'amgen',           instance: 'wd1', site: 'Careers',          name: 'Amgen' },            // 836 India / 1436 total
    { company: 'cadence',         instance: 'wd1', site: 'External_Careers', name: 'Cadence' },          // 282 India / 595 total
    { company: 'fractal',         instance: 'wd1', site: 'Careers',          name: 'Fractal' },          // 205 India / 112 total
    { company: 'micron',          instance: 'wd1', site: 'External',         name: 'Micron' },           // 203 India / 2126 total
    { company: 'dell',            instance: 'wd1', site: 'External',         name: 'Dell' },             // 198 India / 585 total
    { company: 'qualys',          instance: 'wd5', site: 'Careers',          name: 'Qualys' },           // 162 India / 214 total
    { company: 'nxp',             instance: 'wd3', site: 'Careers',          name: 'NXP' },              // 136 India / 476 total
    { company: 'unisys',          instance: 'wd5', site: 'External',         name: 'Unisys' },           // 112 India / 369 total
    { company: 'thales',          instance: 'wd3', site: 'Careers',          name: 'Thales' },           // 106 India / 2000 total

    // ── MEDIUM VOLUME (40–99 India jobs) ────────────────────────────────────
    { company: 'analogdevices',   instance: 'wd1', site: 'External',         name: 'Analog Devices' },   // 84 India / 926 total
    { company: 'paypal',          instance: 'wd1', site: 'Jobs',             name: 'PayPal' },           // 77 India / 639 total
    { company: 'takeda',          instance: 'wd3', site: 'External',         name: 'Takeda' },           // 77 India / 1392 total
    { company: 'globalfoundries', instance: 'wd1', site: 'External',         name: 'GlobalFoundries' },  // 74 India / 570 total
    { company: 'astrazeneca',     instance: 'wd3', site: 'Careers',          name: 'AstraZeneca' },      // 72 India / 1585 total
    { company: 'kone',            instance: 'wd3', site: 'Careers',          name: 'KONE' },             // 68 India / 913 total
    { company: 'intel',           instance: 'wd1', site: 'External',         name: 'Intel' },            // 67 India / 579 total
    { company: 'labcorp',         instance: 'wd1', site: 'External',         name: 'Labcorp' },          // 63 India / 1330 total
    { company: 'browserstack',    instance: 'wd3', site: 'External',         name: 'BrowserStack' },     // 56 India / 62 total
    { company: 'equinix',         instance: 'wd1', site: 'External',         name: 'Equinix' },          // 47 India / 416 total
    { company: 'sprinklr',        instance: 'wd1', site: 'Careers',          name: 'Sprinklr' },         // 46 India / 90 total
    { company: 'chevron',         instance: 'wd5', site: 'Jobs',             name: 'Chevron' },          // 45 India / 166 total
    { company: 'broadridge',      instance: 'wd5', site: 'Careers',          name: 'Broadridge' },       // 45 India / 309 total
    { company: 'boeing',          instance: 'wd1', site: 'External_Careers', name: 'Boeing' },           // 43 India / 1172 total

    // ── LOWER VOLUME (1–39 India jobs) ──────────────────────────────────────
    { company: 'ntst',            instance: 'wd1', site: 'Careers',          name: 'Netsmart' },         // 20 India / 59 total
    { company: 'mars',            instance: 'wd3', site: 'External',         name: 'Mars' },             // 20 India / 678 total
    { company: 'dupont',          instance: 'wd5', site: 'Jobs',             name: 'DuPont' },           // 15 India / 161 total
    { company: 'leidos',          instance: 'wd5', site: 'External',         name: 'Leidos' },           // 9 India / 1881 total
    { company: 'trendmicro',      instance: 'wd3', site: 'External',         name: 'Trend Micro' },      // 8 India / 287 total
    { company: 'rackspace',       instance: 'wd1', site: 'External',         name: 'Rackspace' },        // 6 India / 60 total
    { company: 'mckesson',        instance: 'wd3', site: 'External_Careers', name: 'McKesson' },         // 6 India / 362 total
    { company: 'regeneron',       instance: 'wd1', site: 'Careers',          name: 'Regeneron' },        // 5 India / 448 total
    { company: 'unum',            instance: 'wd1', site: 'External',         name: 'Unum' },             // 1 India / 62 total
    // ── VERIFIED FROM SEARCHES ──
{ company: 'bdx',           instance: 'wd1',  site: 'EXTERNAL_CAREER_SITE_INDIA', name: 'BD (Becton Dickinson)' },
{ company: 'relx',          instance: 'wd3',  site: 'ElsevierJobs',    name: 'Elsevier/RELX' },
{ company: 'hpe',           instance: 'wd5',  site: 'Jobsathpe',       name: 'HPE' },
{ company: 'salesforce',    instance: 'wd12', site: 'External_Career_Site', name: 'Salesforce' },
{ company: 'elevancehealth',instance: 'wd1',  site: 'carelonglobal_in', name: 'Carelon (Elevance)' },
{ company: 'path',          instance: 'wd1',  site: 'External',        name: 'PATH' },

// ── High-confidence Fortune 500 with India offices, most on Workday ──
// (Verify instance via curl to their careers redirect)
{ company: 'accenture',     instance: 'wd3',  site: 'AccentureCareers',name: 'Accenture' },
{ company: 'deloitte',      instance: 'wd103',site: 'External',        name: 'Deloitte' },
{ company: 'nvidia',        instance: 'wd5',  site: 'NVIDIAExternalCareerSite', name: 'NVIDIA' },
{ company: 'adobe',         instance: 'wd5',  site: 'external_experienced', name: 'Adobe' },
{ company: 'autodesk',      instance: 'wd1',  site: 'Ext',             name: 'Autodesk' },
{ company: 'amd',           instance: 'wd1',  site: 'External',        name: 'AMD' },
{ company: 'appliedmaterials', instance: 'wd1', site: 'External',      name: 'Applied Materials' },
{ company: 'kla',           instance: 'wd5',  site: 'Search',          name: 'KLA' },
{ company: 'cisco',         instance: 'wd1',  site: 'External_Career_Site', name: 'Cisco' },
{ company: 'jnj',           instance: 'wd5',  site: 'jnjcareers',      name: 'Johnson & Johnson' },
{ company: 'medtronic',     instance: 'wd1',  site: 'MedtronicCareers', name: 'Medtronic' },
{ company: 'abbott',        instance: 'wd12', site: 'abbottcareers',   name: 'Abbott' },
{ company: 'thermofisher',  instance: 'wd3',  site: 'thermofishercareers', name: 'Thermo Fisher' },
{ company: 'biogen',        instance: 'wd1',  site: 'External',        name: 'Biogen' },
{ company: 'gilead',        instance: 'wd1',  site: 'gileadcareers',   name: 'Gilead' },
{ company: 'novartis',      instance: 'wd3',  site: 'Novartis_Careers', name: 'Novartis' },
{ company: 'sanofi',        instance: 'wd3',  site: 'SanofiCareers',   name: 'Sanofi' },
{ company: 'bayer',         instance: 'wd3',  site: 'bayer',           name: 'Bayer' },
{ company: 'pfizer',        instance: 'wd1',  site: 'PfizerCareers',   name: 'Pfizer' },
{ company: 'lilly',         instance: 'wd5',  site: 'LLY',             name: 'Eli Lilly' },
{ company: 'bms',           instance: 'wd1',  site: 'BMS',             name: 'Bristol-Myers Squibb' },
{ company: 'abbvie',        instance: 'wd1',  site: 'External',        name: 'AbbVie' },
{ company: 'merck',         instance: 'wd5',  site: 'External',        name: 'Merck' },
{ company: 'gsk',           instance: 'wd3',  site: 'GSKcareers',      name: 'GSK' },
{ company: 'walmart',       instance: 'wd5',  site: 'WalmartExternal', name: 'Walmart' },
{ company: 'target',        instance: 'wd5',  site: 'targetcareers',   name: 'Target' },
{ company: 'kroger',        instance: 'wd5',  site: 'External_Career_Site', name: 'Kroger' },
{ company: 'jpmc',          instance: 'wd1',  site: 'jpmc',            name: 'JPMorgan Chase' },
{ company: 'wellsfargo',    instance: 'wd1',  site: 'External',        name: 'Wells Fargo' },
{ company: 'citi',          instance: 'wd1',  site: 'Citi_Careers',    name: 'Citi' },
{ company: 'bofa',          instance: 'wd12', site: 'BofA_Careers',    name: 'Bank of America' },
{ company: 'ms',            instance: 'wd1',  site: 'External',        name: 'Morgan Stanley' },
{ company: 'schwab',        instance: 'wd1',  site: 'External',        name: 'Charles Schwab' },
{ company: 'fidelity',      instance: 'wd1',  site: 'fidelitycareers', name: 'Fidelity' },
{ company: 'amex',          instance: 'wd1',  site: 'AXP',             name: 'American Express' },
{ company: 'mastercard',    instance: 'wd5',  site: 'CorporateCareers', name: 'Mastercard' },
{ company: 'metlife',       instance: 'wd5',  site: 'External',        name: 'MetLife' },
{ company: 'prudential',    instance: 'wd5',  site: 'PruCareers',      name: 'Prudential' },
{ company: 'allstate',      instance: 'wd1',  site: 'External',        name: 'Allstate' },
{ company: 'progressive',   instance: 'wd5',  site: 'External',        name: 'Progressive' },
{ company: 'travelers',     instance: 'wd5',  site: 'External',        name: 'Travelers' },
{ company: 'unitedhealthgroup', instance: 'wd1', site: 'External',    name: 'UnitedHealth Group' },
{ company: 'humana',        instance: 'wd1',  site: 'External',        name: 'Humana' },
{ company: 'cvs',           instance: 'wd1',  site: 'External',        name: 'CVS Health' },
{ company: 'siemens',       instance: 'wd3',  site: 'siemens',         name: 'Siemens' },
{ company: 'se',            instance: 'wd3',  site: 'External',        name: 'Schneider Electric' },
{ company: 'schneider-electric', instance: 'wd3', site: 'Careers',    name: 'Schneider Electric' },
{ company: 'honeywell',     instance: 'wd1',  site: 'Professional_Careers', name: 'Honeywell' },
{ company: '3m',            instance: 'wd1',  site: 'Search',          name: '3M' },
{ company: 'ge',            instance: 'wd5',  site: 'GE_ExternalSite', name: 'GE' },
{ company: 'gehealthcare',  instance: 'wd5',  site: 'External',        name: 'GE HealthCare' },
{ company: 'colgate',       instance: 'wd5',  site: 'Colgate',         name: 'Colgate-Palmolive' },
{ company: 'nestle',        instance: 'wd3',  site: 'Nestle_External_Careers', name: 'Nestle' },
{ company: 'pepsico',       instance: 'wd5',  site: 'PepsiCoCareers',  name: 'PepsiCo' },
{ company: 'cocacola',      instance: 'wd1',  site: 'coca_cola_careers', name: 'Coca-Cola' },
{ company: 'kraftheinz',    instance: 'wd12', site: 'KraftHeinz',      name: 'Kraft Heinz' },
{ company: 'generalmills',  instance: 'wd1',  site: 'External',        name: 'General Mills' },
{ company: 'kellanova',     instance: 'wd1',  site: 'External',        name: 'Kellanova' },
{ company: 'mondelez',      instance: 'wd1',  site: 'External',        name: 'Mondelez' },
{ company: 'diageo',        instance: 'wd3',  site: 'Diageo_Careers',  name: 'Diageo' },
{ company: 'reckittbenckiser', instance: 'wd3', site: 'RB_Careers',   name: 'Reckitt' },
{ company: 'philips',       instance: 'wd3',  site: 'jobs-and-careers', name: 'Philips' },
{ company: 'siemens-healthineers', instance: 'wd3', site: 'External', name: 'Siemens Healthineers' },
{ company: 'baxter',        instance: 'wd5',  site: 'External',        name: 'Baxter' },
{ company: 'ford',          instance: 'wd1',  site: 'FordCareers',     name: 'Ford' },
{ company: 'gm',            instance: 'wd1',  site: 'External',        name: 'General Motors' },
{ company: 'volkswagen',    instance: 'wd3',  site: 'VW_ExternalCareers', name: 'Volkswagen' },
{ company: 'bmw',           instance: 'wd3',  site: 'BMWGroup',        name: 'BMW Group' },
{ company: 'mercedes-benz', instance: 'wd3',  site: 'MBcars',          name: 'Mercedes-Benz' },
{ company: 'adidas',        instance: 'wd3',  site: 'adidas',          name: 'adidas' },
{ company: 'lvmh',          instance: 'wd3',  site: 'LVMH_Careers',    name: 'LVMH' },
{ company: 'disney',        instance: 'wd5',  site: 'disneycareer',    name: 'Disney' },
{ company: 'comcast',       instance: 'wd5',  site: 'Comcast_Careers', name: 'Comcast' },
{ company: 'warnerbros',    instance: 'wd5',  site: 'global',          name: 'Warner Bros Discovery' },
{ company: 'paramount',     instance: 'wd5',  site: 'ParamountCareers',name: 'Paramount' },
{ company: 'nbcuniversal',  instance: 'wd1',  site: 'nbcunicareers',   name: 'NBCUniversal' },
{ company: 'aa',            instance: 'wd1',  site: 'American_Airlines', name: 'American Airlines' },
{ company: 'delta',         instance: 'wd1',  site: 'DeltaCareers',    name: 'Delta Air Lines' },
{ company: 'united',        instance: 'wd1',  site: 'UnitedCareers',   name: 'United Airlines' },
{ company: 'boozallen',     instance: 'wd1',  site: 'BAH_Jobs',        name: 'Booz Allen Hamilton' },
{ company: 'cbre',          instance: 'wd1',  site: 'CBRE',            name: 'CBRE' },
{ company: 'jll',           instance: 'wd1',  site: 'jllcareers',      name: 'JLL' },
{ company: 'cushmanwakefield', instance: 'wd1', site: 'CWCareers',    name: 'Cushman & Wakefield' },
{ company: 'publicisgroupe',instance: 'wd3',  site: 'External',        name: 'Publicis Groupe' },
{ company: 'omnicom',       instance: 'wd5',  site: 'omnicom',         name: 'Omnicom' },
{ company: 'nielsen',       instance: 'wd1',  site: 'Nielsen_External_Careers', name: 'Nielsen' },
{ company: 'niq',           instance: 'wd1',  site: 'NIQ_External_Careers', name: 'NielsenIQ' },
{ company: 'gartner',       instance: 'wd1',  site: 'EXT',             name: 'Gartner' },
{ company: 'forrester',     instance: 'wd1',  site: 'External',        name: 'Forrester' },
{ company: 'idc',           instance: 'wd1',  site: 'External',        name: 'IDC' },
{ company: 'spglobal',      instance: 'wd1',  site: 'External',        name: 'S&P Global' },
{ company: 'moodys',        instance: 'wd1',  site: 'Careers',         name: "Moody's" },
{ company: 'factset',       instance: 'wd1',  site: 'FactSetCareers',  name: 'FactSet' },
{ company: 'msci',          instance: 'wd5',  site: 'External',        name: 'MSCI' },
{ company: 'cmegroup',      instance: 'wd5',  site: 'External',        name: 'CME Group' },
{ company: 'ice',           instance: 'wd1',  site: 'Careers',         name: 'ICE' },
{ company: 'wolterskluwer', instance: 'wd3',  site: 'External',        name: 'Wolters Kluwer' },
{ company: 'pearson',       instance: 'wd3',  site: 'PearsonCareers',  name: 'Pearson' },
{ company: 'genpact',       instance: 'wd1',  site: 'Genpact',         name: 'Genpact' },
{ company: 'wns',           instance: 'wd1',  site: 'External',        name: 'WNS' },
{ company: 'firstsource',   instance: 'wd3',  site: 'firstsource',     name: 'Firstsource' },
{ company: 'ltimindtree',   instance: 'wd5',  site: 'External',        name: 'LTIMindtree' },
{ company: 'hcltech',       instance: 'wd3',  site: 'External',        name: 'HCLTech' },
{ company: 'techmahindra',  instance: 'wd3',  site: 'External',        name: 'Tech Mahindra' },
{ company: 'coforge',       instance: 'wd5',  site: 'External',        name: 'Coforge' },
{ company: 'mphasis',       instance: 'wd1',  site: 'External',        name: 'Mphasis' },
{ company: 'oracle',        instance: 'wd1',  site: 'External',        name: 'Oracle' },
{ company: 'sap',           instance: 'wd3',  site: 'SAP_SuccessFactors_Careers', name: 'SAP' },
{ company: 'infor',         instance: 'wd1',  site: 'Infor',           name: 'Infor' },
{ company: 'epicor',        instance: 'wd1',  site: 'External',        name: 'Epicor' },
{ company: 'openai',        instance: 'wd1',  site: 'External',        name: 'OpenAI' }, // if not on Ashby
];

export const workdayConfig = {
    siteName: 'Workday Jobs',
    companyBoards,
    _allJobsQueue: [],
    _initialized: false,
    needsDescriptionScraping: true,

    async initialize() {
        if (this._initialized) return;
        console.log(`[Workday] Fetching jobs from ${this.companyBoards.length} companies...`);
        let indiaJobsTotal = 0;
        let successCount = 0;
        let failCount = 0;
        let emptyCount = 0;
        for (const board of this.companyBoards) {
            const { company, instance, site, name } = board;
            const baseUrl = `https://${company}.${instance}.myworkdayjobs.com`;
            const listUrl = `${baseUrl}/wday/cxs/${company}/${site}/jobs`;
            let jobs = [];
            let total = 0;
            let offset = 0;
            const limit = 20;
            let indiaJobs = [];
            try {
                // Initial fetch to get total
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);
                const res = await fetch(listUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: '' }),
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                if (!res.ok) {
                    failCount++;
                    console.log(`[Workday] ❌ ${company} (${name}): ${res.status} — skipping`);
                    continue;
                }
                const data = await res.json();
                total = data.total || 0;
                if (!total) {
                    emptyCount++;
                    continue;
                }
                // Paginate
                let page = 0;
                while (offset < total) {
                    if (page > 0) await new Promise(r => setTimeout(r, 200));
                    const controllerPage = new AbortController();
                    const timeoutPage = setTimeout(() => controllerPage.abort(), 30000);
                    const resp = page === 0 ? res : await fetch(listUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                        },
                        body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: '' }),
                        signal: controllerPage.signal,
                    });
                    clearTimeout(timeoutPage);
                    if (!resp.ok) break;
                    const pageData = page === 0 ? data : await resp.json();
                    const pageJobs = (pageData.jobPostings || []).map(j => ({ ...j, _company: company, _instance: instance, _site: site, _companyName: name }));
                    jobs.push(...pageJobs);
                    offset += limit;
                    page++;
                }
                // Filter for India jobs
                const indianCities = [
                    'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
                    'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
                    'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh',
                    'indore', 'nagpur', 'coimbatore', 'kochi', 'cochin',
                    'thiruvananthapuram', 'trivandrum', 'visakhapatnam', 'vizag',
                    'bhubaneswar', 'mangalore', 'mysore', 'mysuru', 'vadodara',
                    'surat', 'patna', 'ranchi', 'guwahati', 'bhopal'
                ];
                indiaJobs = jobs.filter(j => {
                    const loc = (j.locationsText || '').toLowerCase();
                    return loc.includes('india') || indianCities.some(city => loc.includes(city));
                });
                if (indiaJobs.length > 0) {
                    console.log(`[Workday] ✅ ${company} (${name}): ${indiaJobs.length} India jobs (${total} total)`);
                    this._allJobsQueue.push(...indiaJobs);
                    indiaJobsTotal += indiaJobs.length;
                    successCount++;
                } else {
                    console.log(`[Workday]    ${company} (${name}): ${total} jobs, 0 in India`);
                    emptyCount++;
                }
                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                failCount++;
                console.log(`[Workday] ❌ ${company} (${name}): ${err?.message || err}`);
            }
        }
        console.log(`[Workday] ✅ Summary: ${successCount} companies with India jobs, ${failCount} failed, ${emptyCount} empty`);
        console.log(`[Workday] 📊 Total India jobs queued: ${indiaJobsTotal}`);
        this._initialized = true;
    },

    async fetchPage(offset, limit) {
        if (!this._initialized) await this.initialize();
        const jobs = this._allJobsQueue.slice(offset, offset + limit);
        return { jobs, total: this._allJobsQueue.length };
    },

    getJobs(data) {
        return data.jobs || [];
    },

    getTotal(data) {
        return data.total || 0;
    },

    extractJobID(job) {
        // Prefix with workday_{companySlug}_
        return `workday_${job._company}_${job.bulletFields?.[0] || ''}`;
    },

    extractJobTitle(job) {
        return job.title;
    },

    extractCompany(job) {
        return job._companyName;
    },

    extractLocation(job) {
        return job.locationsText || '';
    },

    extractDescription(job) {
        // Always null, filled by getDetails
        return null;
    },

    extractURL(job) {
        // Will be filled by getDetails
        return null;
    },

    extractPostedDate(job) {
        // Not available in list, filled by getDetails
        return null;
    },

    async getDetails(rawJob, sessionHeaders) {
        const { _company, _instance, _site, externalPath, _companyName } = rawJob;
        if (!_company || !_instance || !_site || !externalPath) return null;
        const baseUrl = `https://${_company}.${_instance}.myworkdayjobs.com`;
        const detailUrl = `${baseUrl}/wday/cxs/${_company}/${_site}${externalPath}`;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            const res = await fetch(detailUrl, {
                method: 'GET',
                headers: { 'Accept': 'application/json', ...(sessionHeaders || {}) },
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!res.ok) return null;
            const data = await res.json();
            const info = data.jobPostingInfo || {};
            const hiringOrg = data.hiringOrganization || {};
            return {
                Description: info.jobDescription || null,
                DescriptionPlain: StripHtml(info.jobDescription || ''),
                ApplicationURL: info.externalUrl || null,
                DirectApplyURL: info.externalUrl || null,
                ContractType: info.timeType || null,
                PostedDate: info.startDate ? new Date(info.startDate) : null,
                Company: hiringOrg.name || _companyName,
            };
        } catch (err) {
            return null;
        }
    },
};
