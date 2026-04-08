export interface FollowedPerson {
  id: string;
  name: string;
  voiceFrequency?: number;
  sampleCount: number;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
  voiceSample?: string;
  voiceFrequency?: number;
  followedPersons?: FollowedPerson[];
  createdAt: string;
}

export interface TranscriptItem {
  speaker: 'me' | 'other' | string; // string for followed person ID
  text: string;
  timestamp: number;
}

export interface AudioRecord {
  id: string;
  userId: string;
  title: string;
  startTime: string;
  endTime?: string;
  duration?: number;
  transcript: TranscriptItem[];
  summary?: string;
  analysis?: string;
  isHighPriority: boolean;
  status: 'recording' | 'processing' | 'completed';
}
