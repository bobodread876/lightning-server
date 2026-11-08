// The LND invoice subscription that used to live here is gone. Payment notifications
// now arrive from phoenixd as webhooks at /api/phoenixd/<anything> (see that route).
// This route stays so old links to /api/notifier/run keep returning something sensible.

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    message: 'Notifications are delivered by phoenixd webhooks to /api/phoenixd/hook. Nothing to run here.',
  });
}
