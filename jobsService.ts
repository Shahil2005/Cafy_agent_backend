import * as admin from 'firebase-admin';
import { sanitizeHttpUrl } from './utils/emailSecurity';

// --- Interfaces ---

export interface JobRequest {
    company: string;
    role: string;
    portal: string;
    link?: string;
    status: string;
    job_description?: string;
    isManual: boolean;
    interviewDate?: string; // YYYY-MM-DD
    interviewTime?: string; // HH:mm
}

export interface JobResponse {
    success: boolean;
    message: string;
    jobId?: string;
    job?: any;
    error?: string;
    errors?: string[];
}

// --- Validation Constants ---

const VALID_STATUSES = ['Applied', 'Interview', 'Offer', 'Rejected', 'On Hold', 'Matched'];
const MAX_DESCRIPTION_LENGTH = 50000;

// --- Helper Functions ---

// --- Main Service Function ---

/**
 * Adds a new job to the user's collection.
 * @param userId The ID of the user adding the job.
 * @param jobData The job data payload.
 * @returns A JobResponse object.
 */
export const addJob = async (userId: string, jobData: any): Promise<JobResponse> => {
    try {
        const errors: string[] = [];

        // Required fields
        if (!jobData.company || !jobData.company.trim()) errors.push('company is required');
        if (!jobData.role || !jobData.role.trim()) errors.push('role is required');
        if (!jobData.portal || !jobData.portal.trim()) errors.push('portal is required');

        if (jobData.company.length > 100) errors.push('company cannot exceed 100 characters'); // Adding sanity check just in case

        // isManual forced to true - no validation needed

        // Status validation (Case Insensitive)
        let normalizedStatus = '';
        if (jobData.status) {
            const statusInput = jobData.status.trim().toLowerCase();
            // Find matching valid status
            const match = VALID_STATUSES.find(s => s.toLowerCase() === statusInput);
            if (match) {
                normalizedStatus = match;
            } else {
                errors.push(`status must be one of: ${VALID_STATUSES.join(', ')} (case insensitive)`);
            }
        } else {
            errors.push('status is required');
        }

        // Conditional Validation for Interview
        // Check using the normalized status
        if (normalizedStatus === 'Interview') {
            if (!jobData.interviewDate) {
                errors.push('interviewDate is required when status is Interview');
            }
            if (!jobData.interviewTime) {
                errors.push('interviewTime is required when status is Interview');
            }

            if (jobData.interviewDate && jobData.interviewTime) {
                // Validate format loosely or try to parse
                // Validate future date
                const dateTimeStr = `${jobData.interviewDate}T${jobData.interviewTime}`;
                const interviewDate = new Date(dateTimeStr);
                const now = new Date();

                if (isNaN(interviewDate.getTime())) {
                    errors.push('Invalid format for interviewDate or interviewTime');
                } else if (interviewDate <= now) {
                    errors.push('Interview date and time must be in the future');
                }
            }
        }

        let safeLink: string | null = null;
        if (jobData.link && String(jobData.link).trim()) {
            safeLink = sanitizeHttpUrl(jobData.link);
            if (!safeLink) {
                errors.push('link must be a valid http or https URL');
            }
        }

        if (jobData.job_description && jobData.job_description.length > MAX_DESCRIPTION_LENGTH) {
            errors.push(`job_description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters`);
        }

        if (errors.length > 0) {
            return {
                success: false,
                message: 'Validation error',
                errors
            };
        }

        // 2. Prepare Data for Firestore
        const now = admin.firestore.Timestamp.now();

        // Construct the document data
        const firestoreData = {
            company: jobData.company.trim(),
            role: jobData.role.trim(),
            portal: jobData.portal.trim(),
            link: safeLink,
            status: normalizedStatus, // Use the normalized, Title Cased status

            job_description: jobData.job_description || '',
            isManual: true, // Always true for this endpoint

            interviewDate: jobData.interviewDate || null,
            interviewTime: jobData.interviewTime || null,

            // System fields
            appliedDate: now,
            createdAt: now,
            isFavorite: false,
            match_score: jobData.match_score || 0,
            summary: jobData.summary || '',
            requirements_met: jobData.requirements_met || [],
            requirements_partially_met: jobData.requirements_partially_met || [],
            requirements_not_met: jobData.requirements_not_met || [],
            improvements_needed: jobData.improvements_needed || []
        };

        // 3. Database Operation
        const db = admin.firestore();
        // Updated collection path as per user edit
        const docRef = await db.collection('users').doc(userId).collection('job_applications').add(firestoreData);

        // 4. Construct Success Response
        const responseJob = {
            id: docRef.id,
            ...firestoreData,
            appliedDate: now.toDate().toISOString(),
            createdAt: now.toDate().toISOString()
        };

        return {
            success: true,
            message: 'Job added successfully',
            jobId: docRef.id,
            job: responseJob
        };

    } catch (error: any) {
        console.error('Error in addJob service:', error);
        return {
            success: false,
            message: 'Failed to add job',
            error: error.message || 'Internal Server Error'
        };
    }
};
