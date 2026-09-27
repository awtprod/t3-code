# Connect publishing accounts

Publishing accounts are the YouTube and Instagram accounts finished clips can be published to. They
are managed in **Settings > Connections > Publishing accounts** and belong to the environment you
are connected to, not to a Space.

## Instagram

Instagram uses a long-lived access token for an Instagram professional account ("Instagram API with
Instagram Login").

1. Open **Settings > Connections** and find **Instagram** under **Publishing accounts**.
2. Choose **Connect**.
3. Paste the long-lived access token and choose **Connect**.

Command Center checks the token with Instagram before saving it and shows the connected username and
when the token expires. Long-lived tokens last about 60 days; Command Center renews the token
automatically whenever it is used within 15 days of expiry. If renewal fails, the row shows the
reason and the existing token keeps working until it expires. An expired token must be replaced with
**Reconnect**.

Choose **Disconnect** to delete the stored token from the environment.

Connecting an account never publishes anything.

## YouTube

The YouTube row is shown but cannot be connected yet.

Tokens stay in the environment's runtime credential storage. They are never sent back to the app or
written to configuration.
