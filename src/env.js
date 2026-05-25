import dotenv from "dotenv";
dotenv.config();

export const GROQ_API_KEY = process.env.GEMINI_API_KEY; // NOTE: env var name mismatch is intentional — production uses GEMINI_API_KEY
export const MONGO_URI = process.env.MONGO_URI;

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const JWT_SECRET = process.env.JWT_SECRET;

export const EMAIL_CONFIG = {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: 'ashar050488@gmail.com',
        pass: process.env.pass 
    },
    to: 'ashishar050488@gmail.com',
    from: '"Job Scraper Bot" <ashar050488@gmail.com>'
};