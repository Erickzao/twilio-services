import Twilio from 'twilio';
import { logger } from '@/shared/utils/logger';

const twilioConfig = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
};

function validateConfig(): boolean {
  const { accountSid, authToken, phoneNumber } = twilioConfig;

  if (!accountSid || !authToken || !phoneNumber) {
    logger.warn('Twilio credentials not configured. SMS features will be disabled.', 'Twilio');
    return false;
  }

  return true;
}

let twilioClient: Twilio.Twilio | null = null;

export function getTwilioClient(): Twilio.Twilio | null {
  if (!validateConfig()) {
    return null;
  }

  if (!twilioClient) {
    twilioClient = Twilio(twilioConfig.accountSid, twilioConfig.authToken);
    logger.log('Twilio client initialized', 'Twilio');
  }

  return twilioClient;
}

export async function sendSMS(to: string, body: string): Promise<boolean> {
  const client = getTwilioClient();

  if (!client) {
    logger.error('Cannot send SMS: Twilio client not initialized', 'Twilio');
    return false;
  }

  try {
    const message = await client.messages.create({
      body,
      from: twilioConfig.phoneNumber,
      to,
    });

    logger.log(`SMS sent successfully. SID: ${message.sid}`, 'Twilio');
    return true;
  } catch (error) {
    logger.error(`Failed to send SMS: ${error}`, 'Twilio');
    return false;
  }
}

export { twilioConfig };
