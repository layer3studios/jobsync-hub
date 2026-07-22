import fetch from 'node-fetch';

export const greenhouseConfig = {
    siteName: "Greenhouse Jobs",
    baseUrl: "https://boards-api.greenhouse.io/v1/boards",
    
    companyBoardTokens: [
        // ✅ WORKING TOKENS (verified)
        'airbnb',
        'stripe',
        'figma',
        'airtable',
        'gitlab',
        'reddit',
        'pinterest',
        'twitch',
        
        // ✅ ADDITIONAL WORKING TOKENS (tech companies with India jobs)
        'wolt',
        'contentful',
        'celonis',
        'n26',
        'raisin',
        'eyeo',
        
        // ✅ More tech companies (may or may not have India jobs)
        'datadog',
        'asana',
        'dropbox',
        'databricks',
        'cloudflare',
        'mongodb',
        'elastic',
        'okta',
        'hubspot',
        'intercom',
        'amplitude',
        'mixpanel',
        'launchdarkly',
        'pagerduty',

        // ── Discovered via API scan ──
        'zscaler',
        'sigmoid',
        'rubrik',
        'inmobi',
        'phonepe',
        'highradius',
        'toast',
        'glance',
        'zenoti',
        'tripactions',
        'groww',
        'hackerrank',
        'druva',
        'twilio',
        'commvault',
        'postman',
        'newrelic',
        'yugabyte',
        'coinbase',
        'coursera',
        'samsara',
        'observeai',
        'flexport',
        'thoughtworks',
        'fastly',
        'neo4j',
        'cockroachlabs',
        'singlestore',
        'verkada',
        'starburst',
        'duolingo',
        'labelbox',
        'naukri',

        // ── Discovered via ATS scan (Mar 2026) ──
        'tcs',
        'slice',
        // ── High-confidence: Indian unicorns/soonicorns ──
'digit',

// ── High-confidence: Global tech with India engineering ──
'databricks',
'circleci',
'buildkite',
'launchdarkly',
'fivetran',
'dremio',
'clickhouse',
'planetscale',
'netlify',
'nubank',
'brex',
'mercury',
'chime',
'affirm',
'discord',
'roblox',
'coinbase', // in case not tried
'gemini',
'okx',
'bybit',
'bitgo',
'fireblocks',
'consensys',
'zscaler', // already there, dedupe on your end
'commvault', // dupe check
'rubrik', // dupe
'druva', // dupe
'mongodb', // dupe
'nubank',

// ── High-confidence: US SaaS with big India presence ──
'gusto',
'zoominfo',
'6sense',
'salesloft',
'greenhouse', // Greenhouse itself
    ],
    
    // Internal state
    _currentBoardIndex: 0,
    _allJobsQueue: [],
    _initialized: false,
    
    // Fetch all jobs from all boards upfront
    async initialize() {
        if (this._initialized) return;
        
        console.log(`[Greenhouse] Fetching jobs from ${this.companyBoardTokens.length} companies...`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (const boardToken of this.companyBoardTokens) {
            try {
                const url = `${this.baseUrl}/${boardToken}/jobs?content=true`;
                const response = await fetch(url);
                
                if (!response.ok) {
                    failCount++;
                    // Only log if you want to see failures (comment out to reduce noise)
                    // console.log(`[Greenhouse] ❌ ${boardToken}: ${response.status}`);
                    continue;
                }
                
                const data = await response.json();
                
                if (!data.jobs || data.jobs.length === 0) {
                    continue;
                }
                
                // Filter for India and add board token
                const indiaJobs = data.jobs
                    .filter(job => {
                        const location = job.location?.name || '';
                        return this.isIndiaLocation(location);
                    })
                    .map(job => ({
                        ...job,
                        _boardToken: boardToken
                    }));
                
                if (indiaJobs.length > 0) {
                    console.log(`[Greenhouse] ✅ ${boardToken}: ${indiaJobs.length} jobs in India (${data.jobs.length} total)`);
                    this._allJobsQueue.push(...indiaJobs);
                    successCount++;
                }
                
                // Rate limit: wait 500ms between companies
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                failCount++;
                console.error(`[Greenhouse] ❌ ${boardToken}: ${error.message}`);
            }
        }
        
        console.log(`[Greenhouse] ✅ Summary: ${successCount} companies with India jobs, ${failCount} failed/empty`);
        console.log(`[Greenhouse] 📊 Total jobs found: ${this._allJobsQueue.length}`);
        this._initialized = true;
    },
    
    // Fetch jobs page (required by scraperEngine)
    async fetchPage(offset, limit) {
        // Initialize on first call
        if (!this._initialized) {
            await this.initialize();
        }
        
        // Return paginated chunk
        const jobs = this._allJobsQueue.slice(offset, offset + limit);
        return { jobs, total: this._allJobsQueue.length };
    },
    
    // Required by scraperEngine
    getJobs(data) {
        return data.jobs || [];
    },
    
    // Get total (for pagination)
    getTotal(data) {
        return data.total || 0;
    },
    
    // Extract job ID
    extractJobID(job) {
        return `greenhouse_${job._boardToken}_${job.id}`;
    },
    
    // Extract job title
    extractJobTitle(job) {
        return job.title;
    },
    
    // Extract company name
    extractCompany(job) {
        const boardToken = job._boardToken;
        
        // Try to get from metadata
        if (job.metadata && job.metadata.length > 0) {
            const companyField = job.metadata.find(m => m.name.toLowerCase().includes('company'));
            if (companyField) return companyField.value;
        }
        
        // Format board token to readable name
        return boardToken
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },
    
    // Extract location
    extractLocation(job) {
        return job.location?.name || 'India';
    },
    
    // Extract description
    extractDescription(job) {
        return job.content || '';
    },
    
    // Extract URL
    extractURL(job) {
        return job.absolute_url;
    },
    
    // Extract posted date
    extractPostedDate(job) {
        return job.updated_at;
    },
    
    // Check if location is in India
    isIndiaLocation(location) {
        const indianCities = [
            'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
            'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
            'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh',
            'indore', 'nagpur', 'coimbatore', 'kochi', 'cochin',
            'thiruvananthapuram', 'trivandrum', 'visakhapatnam', 'vizag',
            'bhubaneswar', 'mangalore', 'mysore', 'mysuru', 'vadodara',
            'surat', 'patna', 'ranchi', 'guwahati', 'bhopal'
        ];
        
        const locationLower = location.toLowerCase();
        
        // Check for India or IN
        if (locationLower.includes('india') || 
            locationLower.match(/\bin\b/)) {
            return true;
        }
        
        // Check for Indian cities
        return indianCities.some(city => locationLower.includes(city));
    }
};