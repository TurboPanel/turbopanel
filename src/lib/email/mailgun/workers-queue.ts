import {
  resolveEmailSettings,
  resolveWorkersEmailProvider,
} from '../../settings/email-settings.ts'
import type { Db } from '../../../db.ts'
import { createNoopQueue } from '../noop-queue.ts'
import type { EmailJob, EmailQueue } from '../types.ts'
import { sendMailgunJob } from './send.ts'

type WorkersMailgunQueueOptions = {
  apiKey: string
  domain: string
  from: string
  apiBase: string
}

class WorkersMailgunQueue implements EmailQueue {
  constructor(private readonly opts: WorkersMailgunQueueOptions) {}

  async enqueue(job: EmailJob): Promise<void> {
    const outcome = await sendMailgunJob(job, {
      apiKey: this.opts.apiKey,
      domain: this.opts.domain,
      from: this.opts.from,
      apiBase: this.opts.apiBase,
    })
    // #region agent log
    fetch('http://localhost:7440/ingest/3e0179a5-fa63-49e5-b717-b62ee1a155c9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'543aa9'},body:JSON.stringify({sessionId:'543aa9',location:'workers-queue.ts:enqueue',message:'mailgun enqueue outcome',data:{jobType:job.type,to:job.to,ok:outcome.ok,permanent:!outcome.ok?outcome.permanent:undefined,error:!outcome.ok?outcome.error.slice(0,120):undefined,domain:this.opts.domain,from:this.opts.from,apiBase:this.opts.apiBase},timestamp:Date.now(),hypothesisId:'B',runId:'post-fix'})}).catch(()=>{});
    // #endregion
    if (!outcome.ok) {
      console.error('[TurboPanel email] Mailgun send failed', {
        error: outcome.error,
        permanent: outcome.permanent,
      })
      throw new Error(outcome.error)
    }
  }
}

export function createWorkersMailgunQueue(opts: WorkersMailgunQueueOptions): EmailQueue {
  return new WorkersMailgunQueue(opts)
}

export async function resolveWorkersEmailQueue(
  db: Db | undefined,
  env: Record<string, string | undefined>,
): Promise<EmailQueue> {
  const resolved = await resolveEmailSettings(db, env)
  const workersProvider = resolveWorkersEmailProvider(resolved)
  if (workersProvider !== 'mailgun') {
    // #region agent log
    fetch('http://localhost:7440/ingest/3e0179a5-fa63-49e5-b717-b62ee1a155c9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'543aa9'},body:JSON.stringify({sessionId:'543aa9',location:'workers-queue.ts:resolveWorkersEmailQueue',message:'noop queue: provider not mailgun',data:{provider:resolved.provider,workersProvider,providerSource:resolved.keys.PROVIDER.source},timestamp:Date.now(),hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    return createNoopQueue()
  }

  const apiKey = resolved.mailgunApiKey?.trim() ?? ''
  const domain = resolved.mailgunDomain?.trim() ?? ''
  if (apiKey === '' || domain === '') {
    // #region agent log
    fetch('http://localhost:7440/ingest/3e0179a5-fa63-49e5-b717-b62ee1a155c9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'543aa9'},body:JSON.stringify({sessionId:'543aa9',location:'workers-queue.ts:resolveWorkersEmailQueue',message:'noop queue: missing mailgun credentials',data:{hasApiKey:apiKey!=='',hasDomain:domain!=='',providerSource:resolved.keys.PROVIDER.source},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    return createNoopQueue()
  }

  return createWorkersMailgunQueue({
    apiKey,
    domain,
    from: resolved.from,
    apiBase: resolved.mailgunApiBase,
  })
}
