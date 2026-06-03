// FILE: src/Db/companies/directory.js
// Directory + manual-company CRUD.

import { ObjectId } from 'mongodb';
import { col } from '../connection.js';

/** Aggregated directory of all companies with active roles. */
export async function getCompanyDirectoryStats() {
  try {
    const jobs = await col('jobs');
    const pipeline = [
      { $match: { Status: 'active' } },
      {
        $group: {
          _id: '$Company',
          openRoles: { $sum: 1 },
          locations: { $addToSet: '$Location' },
          sampleUrl: { $first: '$ApplicationURL' },
        },
      },
      { $sort: { openRoles: -1 } },
    ];
    const scrapedStats = await jobs.aggregate(pipeline).toArray();

    const formattedScraped = scrapedStats.map(stat => ({
      _id: stat._id,
      companyName: stat._id || 'Unknown',
      openRoles: stat.openRoles,
      cities: [...new Set((stat.locations || []).map(l => (l || '').split(',')[0].trim()))]
        .filter(Boolean)
        .slice(0, 2),
      domain: String(stat._id || '').toLowerCase().replace(/[^a-z0-9-]/g, '') + '.com',
      source: 'scraped',
    }));

    const manualCol = await col('manual_companies');
    const manualCompanies = await manualCol.find({}).toArray();
    const formattedManual = manualCompanies.map(c => ({
      _id: c._id.toString(),
      companyName: c.name,
      openRoles: 0,
      cities: c.cities ? c.cities.split(',').map(s => s.trim()) : [],
      domain: c.domain,
      source: 'manual',
    }));

    const scrapedNames = new Set(formattedScraped.map(c => c.companyName.toLowerCase()));
    const uniqueManual = formattedManual.filter(c => !scrapedNames.has(c.companyName.toLowerCase()));

    return [...formattedScraped, ...uniqueManual];
  } catch (err) {
    console.error('[getCompanyDirectoryStats]', err);
    return [];
  }
}

/** Admin-only: delete all jobs belonging to a given company name. */
export async function deleteJobsByCompany(companyName) {
  const jobs = await col('jobs');
  return jobs.deleteMany({
    Company: { $regex: new RegExp(`^${companyName}$`, 'i') },
  });
}

/** Admin-only: insert a manual company entry. Throws on duplicate. */
export async function addManualCompany(data) {
  const companies = await col('manual_companies');
  const exists = await companies.findOne({
    name: { $regex: new RegExp(`^${data.name}$`, 'i') },
  });
  if (exists) throw new Error('Company already exists in manual list.');
  await companies.insertOne({ ...data, createdAt: new Date() });
}

/** Admin-only: remove a manual company entry. */
export async function deleteManualCompany(id) {
  const companies = await col('manual_companies');
  await companies.deleteOne({ _id: new ObjectId(id) });
}
