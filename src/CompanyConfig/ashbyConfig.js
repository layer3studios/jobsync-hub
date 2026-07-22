import fetch from 'node-fetch';

export const ashbyConfig = {
    siteName: "Ashby Jobs",
    baseUrl: "https://api.ashbyhq.com/posting-api/job-board",
    
    // ✅ VERIFIED WORKING COMPANIES (with India jobs potential)
    companyBoardNames: [
        // Companies confirmed to have India jobs
        'Ashby',
        'Deel',
        'OpenAI',
        'Cohere',
        
        // Additional tech companies using Ashby
        'Linear',
        'Notion',
        'Ramp',
        'Mercury',
        'Supabase',
        'Vercel',
        'Replit',
        'Modal',
        'Perplexity',
        'Cursor',
        'Character',
        
        // ── Discovered via API scan ──
        'confluent',
        'snowflake',
        'redis',
        'clickup',
        'anyscale',
        'docker',

        // ── Discovered via ATS scan (Mar 2026) ──
        'bounce',
        'scaler',
        'yotta',
        'pesto',
        'velotio',
        'loadshare',
        // ── AI-native + modern startups (Ashby's core market) ──
'attio',
'baseten',
'runpod',
'langchain',
'suno',
'elevenlabs',
'harvey',
'gamma',
'granola',
'read-ai',
'zapier', // in case they moved
'raycast',
'pinecone',
'weaviate',
'lancedb',
'crusoe',
'lambda',
'anyscale', // dupe check
'e2b',
'coder',
'cognition',
'poolside',
'reka',
'nous-research',
'exa',

// ── India-focused / dual-HQ ──
'sarvam',

// ── Fintech / crypto ──
'rain',
'unit',

// ── Recent Ashby signups I've seen mentioned ──
'lightspark',
'goldsky',
'alchemy',
'phantom',
    ],
    
    // Internal state
    _allJobsQueue: [],
    _initialized: false,
    
    // Fetch all jobs from all boards upfront
    async initialize() {
        if (this._initialized) return;
        
        console.log(`[Ashby] Fetching jobs from ${this.companyBoardNames.length} companies...`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (const boardName of this.companyBoardNames) {
            try {
                const url = `${this.baseUrl}/${boardName}`;
                const response = await fetch(url);
                
                if (!response.ok) {
                    failCount++;
                    // Only log 404s if you want to see which ones failed
                    // console.log(`[Ashby] ❌ ${boardName}: ${response.status}`);
                    continue;
                }
                
                const data = await response.json();
                
                if (!data.jobs || data.jobs.length === 0) {
                    continue;
                }
                
                // Filter for India jobs
                const indiaJobs = data.jobs.filter(job => {
                    return this.hasIndiaLocation(job);
                }).map(job => ({
                    ...job,
                    _boardName: boardName
                }));
                
                if (indiaJobs.length > 0) {
                    console.log(`[Ashby] ✅ ${boardName}: ${indiaJobs.length} jobs in India (${data.jobs.length} total)`);
                    this._allJobsQueue.push(...indiaJobs);
                    successCount++;
                }
                
                // Rate limit: 300ms between companies
                await new Promise(resolve => setTimeout(resolve, 300));
                
            } catch (error) {
                failCount++;
                console.error(`[Ashby] ❌ ${boardName}: ${error.message}`);
            }
        }
        
        console.log(`[Ashby] ✅ Summary: ${successCount} companies with India jobs, ${failCount} failed/empty`);
        console.log(`[Ashby] 📊 Total jobs found: ${this._allJobsQueue.length}`);
        this._initialized = true;
    },
    
    // Check if job has India location
    hasIndiaLocation(job) {
        const indianCities = [
            'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
            'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
            'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh',
            'indore', 'nagpur', 'coimbatore', 'kochi', 'cochin',
            'thiruvananthapuram', 'trivandrum', 'visakhapatnam', 'vizag',
            'bhubaneswar', 'mangalore', 'mysore', 'mysuru', 'vadodara',
            'surat', 'patna', 'ranchi', 'guwahati', 'bhopal'
        ];
        
        // Check primary location
        if (job.location) {
            const locationLower = job.location.toLowerCase();
            if (locationLower.includes('india') || 
                indianCities.some(city => locationLower.includes(city))) {
                return true;
            }
        }
        
        // Check address
        if (job.address?.postalAddress?.addressCountry) {
            const country = job.address.postalAddress.addressCountry.toLowerCase();
            if (country.includes('india') || country === 'in' || country === 'ind') {
                return true;
            }
        }
        
        // Check secondary locations
        if (job.secondaryLocations && job.secondaryLocations.length > 0) {
            for (const secLoc of job.secondaryLocations) {
                if (secLoc.location) {
                    const locLower = secLoc.location.toLowerCase();
                    if (locLower.includes('india') || 
                        indianCities.some(city => locLower.includes(city))) {
                        return true;
                    }
                }
                if (secLoc.address?.addressCountry) {
                    const country = secLoc.address.addressCountry.toLowerCase();
                    if (country.includes('india') || country === 'in' || country === 'ind') {
                        return true;
                    }
                }
            }
        }
        
        return false;
    },
    
    // Fetch jobs page (required by scraperEngine)
    async fetchPage(offset, limit) {
        if (!this._initialized) {
            await this.initialize();
        }
        
        const jobs = this._allJobsQueue.slice(offset, offset + limit);
        return { jobs, total: this._allJobsQueue.length };
    },
    
    // Required by scraperEngine
    getJobs(data) {
        return data.jobs || [];
    },
    
    // Get total
    getTotal(data) {
        return data.total || 0;
    },
    
    // Extract job ID
    extractJobID(job) {
        // Use jobUrl as unique ID
        const urlParts = job.jobUrl.split('/');
        return `ashby_${job._boardName}_${urlParts[urlParts.length - 1]}`;
    },
    
    // Extract job title
    extractJobTitle(job) {
        return job.title;
    },
    
    // Extract company name
    extractCompany(job) {
        // Format board name to readable company name
        return job._boardName
            .replace(/-/g, ' ')
            .replace(/_/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },
    
    // Extract location
    extractLocation(job) {
        // Combine all India locations
        let locations = [];
        
        // Add primary location if it's India
        if (job.location && this.isIndiaString(job.location)) {
            locations.push(job.location);
        }
        
        // Add secondary India locations
        if (job.secondaryLocations && job.secondaryLocations.length > 0) {
            for (const secLoc of job.secondaryLocations) {
                if (secLoc.location && this.isIndiaString(secLoc.location)) {
                    locations.push(secLoc.location);
                }
            }
        }
        
        return locations.length > 0 ? locations.join(', ') : 'India';
    },
    
    // Helper to check if a location string is India-related
    isIndiaString(locationStr) {
        const indianCities = [
            'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi',
            'hyderabad', 'pune', 'chennai', 'noida', 'gurgaon', 'gurugram',
            'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'chandigarh',
            'indore', 'nagpur', 'coimbatore', 'kochi', 'cochin',
            'thiruvananthapuram', 'trivandrum'
        ];
        
        const locLower = locationStr.toLowerCase();
        return locLower.includes('india') || 
               indianCities.some(city => locLower.includes(city));
    },
    
    // Extract description
    extractDescription(job) {
        // Prefer plain text, fallback to HTML
        return job.descriptionPlain || job.descriptionHtml || '';
    },
    
    // Extract URL
    extractURL(job) {
        return job.applyUrl || job.jobUrl;
    },
    
    // Extract posted date
    extractPostedDate(job) {
        return job.publishedDate;
    }
};