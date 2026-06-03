// FILE: src/core/jobTags/roleCategory.js
// Infers the high-level role category (Frontend / Backend / Data / etc.) from title + description.

import { countMatches, getPlainDescription } from './helpers.js';

const RULES = [
  {
    label: 'ML/AI',
    title: [/\b(?:machine\s+learning|ml\s+engineer|ai\s+engineer|deep\s+learning|nlp|computer\s+vision|llm|genai|generative\s+ai)\b/i],
    desc: [/\b(?:machine\s+learning|llm|pytorch|tensorflow|nlp|computer\s+vision|hugging\s+face|langchain|genai)\b/gi],
  },
  {
    label: 'Data',
    title: [/\b(?:data\s+engineer|data\s+analyst|data\s+scientist|analytics|business\s+intelligence|bi\s+developer|etl)\b/i],
    desc: [/\b(?:data\s+pipeline|etl|warehouse|analytics|tableau|power\s+bi|sql|spark|airflow|dbt|snowflake|bigquery|redshift)\b/gi],
  },
  {
    label: 'Security',
    title: [/\b(?:security|cybersecurity|infosec|penetration|soc\s+analyst)\b/i],
    desc: [/\b(?:security|cybersecurity|infosec|siem|soc|vulnerability|penetration\s+testing|threat)\b/gi],
  },
  {
    label: 'Mobile',
    title: [/\b(?:mobile|ios|android|react\s+native|flutter)\b/i],
    desc: [/\b(?:ios|android|react\s+native|flutter|swiftui|jetpack\s+compose|android\s+sdk|ios\s+sdk)\b/gi],
  },
  {
    label: 'Design',
    title: [/\b(?:designer|ux|ui\/ux|product\s+designer|design\s+engineer)\b/i],
    desc: [/\b(?:ux|ui|figma|prototype|design\s+system|interaction\s+design|visual\s+design)\b/gi],
  },
  {
    label: 'Product',
    title: [/\b(?:product\s+manager|product\s+owner|apm|technical\s+program\s+manager|tpm)\b/i],
    desc: [/\b(?:roadmap|prd|stakeholder|product\s+metrics|go-to-market|feature\s+prioritization)\b/gi],
  },
  {
    label: 'QA',
    title: [/\b(?:qa|quality\s+assurance|test\s+engineer|sdet|automation\s+engineer|test\s+lead)\b/i],
    desc: [/\b(?:qa|quality\s+assurance|automation\s+testing|selenium|playwright|cypress|test\s+cases|sdet)\b/gi],
  },
  {
    label: 'Full Stack',
    title: [/\b(?:full\s*stack|full-stack|fullstack)\b/i],
    desc: [/\b(?:full\s*stack|frontend\s+and\s+backend|end-to-end\s+web)\b/gi],
  },
  {
    label: 'Frontend',
    title: [/\b(?:frontend|front-end|front\s+end|ui\s+engineer|ui\s+developer|react\s+developer|angular\s+developer|vue\s+developer)\b/i],
    desc: [/\b(?:react|next\.js|vue|angular|typescript|html|css|tailwind|webpack|vite|storybook)\b/gi],
  },
  {
    label: 'Backend',
    title: [/\b(?:backend|back-end|back\s+end|server-side|api\s+developer)\b/i],
    desc: [/\b(?:backend|server-side|api|microservices|node\.js|java|spring|django|fastapi|postgresql|mongodb)\b/gi],
  },
  {
    label: 'DevOps/SRE',
    title: [/\b(?:devops|sre|site\s+reliability|infrastructure|cloud\s+engineer)\b/i, /\bplatform\s+engineer\b/i],
    desc: [/\b(?:devops|sre|kubernetes|docker|terraform|ci\/cd|github\s+actions|jenkins|observability|prometheus|grafana|linux|infrastructure|cloud)\b/gi],
  },
];

export function inferRoleCategory(job) {
  const title = String(job.JobTitle ?? '');
  const text = getPlainDescription(job);

  // Title-based shortcut, with two ambiguity fixes for "platform engineer".
  for (const rule of RULES) {
    if (rule.title.some(re => re.test(title))) {
      if (rule.label === 'Backend'
          && /\bplatform\s+engineer\b/i.test(title)
          && /\b(?:infra|infrastructure|cloud|sre|devops)\b/i.test(text)) {
        return 'DevOps/SRE';
      }
      if (rule.label === 'DevOps/SRE'
          && /\bplatform\s+engineer\b/i.test(title)
          && /\b(?:api|backend|services)\b/i.test(text)
          && !/\b(?:infra|infrastructure|cloud|devops|sre)\b/i.test(text)) {
        return 'Backend';
      }
      return rule.label;
    }
  }

  // Description fallback: best score wins, min 2 hits to qualify.
  let best = { label: 'Other', score: 0 };
  for (const rule of RULES) {
    const score = rule.desc.reduce((s, re) => s + countMatches(re, text), 0);
    if (score > best.score) best = { label: rule.label, score };
  }
  return best.score >= 2 ? best.label : 'Other';
}
