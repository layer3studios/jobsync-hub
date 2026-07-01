// FILE: src/models/public/resume-file-model.js
// resume_files collection — metadata for an application's uploaded resume
// (SPEC §5.2). The file bytes live on local disk (R2); this record points at the
// storagePath. extractedText stays null until Step 6 fills it.

import { ObjectId } from 'mongodb';
import { col } from '../../Db/connection.js';

const resumeFilesCol = () => col('resume_files');

function toOid(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
}

/** Idempotent index setup. Called on boot. */
export async function ensureResumeFileIndexes() {
  const collection = await resumeFilesCol();
  await collection.createIndex({ applicationId: 1 }, { name: 'resume_files_applicationId' });
}

/** Record resume-file metadata. applicationId may be null until the app exists. */
export async function createResumeFile(data) {
  const collection = await resumeFilesCol();
  const doc = {
    applicationId: toOid(data.applicationId),
    storagePath: data.storagePath,
    originalFilename: data.originalFilename ?? null,
    mimeType: data.mimeType ?? null,
    sizeBytes: data.sizeBytes ?? null,
    extractedText: null,
    uploadedAt: new Date(),
  };
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Link a resume-file record to its application once the app is created. */
export async function attachResumeFileToApplication(resumeFileId, applicationId) {
  const fileOid = toOid(resumeFileId);
  const appOid = toOid(applicationId);
  if (!fileOid || !appOid) return;
  const collection = await resumeFilesCol();
  await collection.updateOne({ _id: fileOid }, { $set: { applicationId: appOid } });
}

/** Fetch the resume-file record for an application. */
export async function getResumeFileForApplication(applicationId) {
  const oid = toOid(applicationId);
  if (!oid) return null;
  const collection = await resumeFilesCol();
  return collection.findOne({ applicationId: oid });
}
