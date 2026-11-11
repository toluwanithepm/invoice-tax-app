import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../config/env';

export type Channel = 'email' | 'sms';
export interface OutgoingMessage {
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
  workspaceId?: string | null;
  /** Secrets (OTP codes) are delivered but never stored in the outbox. */
  sensitive?: boolean;
}

interface Provider {
  send(m: OutgoingMessage): Promise<string | null>;
}

/** Dev/test sink. Keeps the last 200 messages in memory so local sign-in and tests can read OTPs. */
export const devInbox: OutgoingMessage[] = [];

class ConsoleProvider implements Provider {
  private readonly log = new Logger('Notifications');
  async send(m: OutgoingMessage) {
    devInbox.push(m);
    if (devInbox.length > 200) devInbox.shift();
    if (env().NODE_ENV !== 'test') this.log.log(`[${m.channel} → ${m.recipient}] ${m.subject ?? ''} ${m.body}`);
    return null;
  }
}

class ResendProvider implements Provider {
  async send(m: OutgoingMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env().RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env().EMAIL_FROM, to: [m.recipient], subject: m.subject ?? '', text: m.body }),
    });
    if (!res.ok) throw new Error(`Email provider returned ${res.status}`);
    return ((await res.json()) as { id?: string }).id ?? null;
  }
}

class TermiiProvider implements Provider {
  async send(m: OutgoingMessage) {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env().TERMII_API_KEY,
        to: m.recipient.replace(/^\+/, ''),
        from: env().TERMII_SENDER_ID,
        sms: m.body,
        type: 'plain',
        channel: 'dnd',
      }),
    });
    if (!res.ok) throw new Error(`SMS provider returned ${res.status}`);
    return ((await res.json()) as { message_id?: string }).message_id ?? null;
  }
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');
  private readonly email: Provider = env().EMAIL_PROVIDER === 'resend' ? new ResendProvider() : new ConsoleProvider();
  private readonly sms: Provider = env().SMS_PROVIDER === 'termii' ? new TermiiProvider() : new ConsoleProvider();

  constructor(private readonly prisma: PrismaService) {}

  /** Records the message in the outbox, attempts delivery now, and leaves failures for the retry drain. */
  async send(m: OutgoingMessage): Promise<void> {
    const row = await this.prisma.outboxMessage.create({
      data: {
        workspaceId: m.workspaceId ?? null,
        channel: m.channel,
        recipient: m.recipient,
        subject: m.subject ?? null,
        body: m.sensitive ? '[redacted]' : m.body,
      },
    });
    try {
      const ref = await (m.channel === 'email' ? this.email : this.sms).send(m);
      await this.prisma.outboxMessage.update({
        where: { id: row.id },
        data: { status: 'sent', sentAt: new Date(), providerRef: ref, attempts: 1 },
      });
    } catch (err) {
      this.log.warn({ err, id: row.id }, 'Delivery failed; will retry');
      await this.prisma.outboxMessage.update({
        where: { id: row.id },
        data: { status: m.sensitive ? 'failed' : 'pending', attempts: 1 },
      });
      if (m.sensitive) throw err; // OTPs are not retried later: the user asks again
    }
  }

  /** Retry undelivered, non-sensitive messages (called by the jobs drain). */
  async retryPending(limit = 50) {
    const pending = await this.prisma.outboxMessage.findMany({
      where: { status: 'pending', attempts: { lt: 5 } },
      take: limit,
    });
    for (const p of pending) {
      try {
        const ref = await (p.channel === 'email' ? this.email : this.sms).send({
          channel: p.channel as Channel,
          recipient: p.recipient,
          subject: p.subject ?? undefined,
          body: p.body,
        });
        await this.prisma.outboxMessage.update({
          where: { id: p.id },
          data: { status: 'sent', sentAt: new Date(), providerRef: ref, attempts: { increment: 1 } },
        });
      } catch {
        await this.prisma.outboxMessage.update({
          where: { id: p.id },
          data: { attempts: { increment: 1 }, status: p.attempts + 1 >= 5 ? 'failed' : 'pending' },
        });
      }
    }
  }
}
