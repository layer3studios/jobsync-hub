// config.js
import { StripHtml, COMMON_KEYWORDS } from './utils.js';
import fetch from 'node-fetch'; // fetch is needed for the getDetails function
import { AbortController } from 'abort-controller';
import { greenhouseConfig } from './CompanyConfig/greenhouseConfig.js';
import { ashbyConfig } from './CompanyConfig/ashbyConfig.js';
import { leverConfig } from './CompanyConfig/leverConfig.js';
import { workableConfig } from './CompanyConfig/workableConfig.js';
import { recruiteeConfig } from './CompanyConfig/recruiteeConfig.js';
import { workdayConfig } from './CompanyConfig/workdayConfig.js';
import { personioConfig } from './CompanyConfig/personioConfig.js';
import { smartRecruitersConfig } from './CompanyConfig/smartRecruitersConfig.js';

export const SITES_CONFIG = [
  greenhouseConfig,
  ashbyConfig,
  leverConfig,
  workableConfig,
  recruiteeConfig,
  workdayConfig,
  personioConfig,
  smartRecruitersConfig,
];
