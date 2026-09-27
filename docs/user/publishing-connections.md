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

YouTube uses its own Google OAuth app, separate from the Google account connections used for Gmail.
Until the environment has one, the YouTube row shows as unavailable.

### One-time Google Cloud setup

1. In Google Cloud Console, create (or pick) a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen (External), add the scope
   `https://www.googleapis.com/auth/youtube.upload`, and add your Google account as a **test user**.
3. Create an OAuth client of type **Desktop app**.
4. Give the client to the environment, either as environment variables on the server:
   - `COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID`
   - `COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_SECRET`

   or by saving the downloaded client JSON as the `command-center-youtube-oauth-client` secret
   (the file `command-center-youtube-oauth-client.bin` in the environment's secrets directory,
   readable only by the server user). The environment variables win when both are present.

### Connecting

1. Open **Settings > Connections** and find **YouTube** under **Publishing accounts**.
2. Choose **Connect**, then **Open YouTube authorization**, and approve access with the account that
   owns the channel. Leave the video-upload permission checked.
3. The browser ends on a `127.0.0.1` page that does not load. Copy that full address, paste it into
   the dialog, and choose **Connect**.

The row shows the Google account (and, after the first upload, the channel name). Only a reusable
sign-in token is stored; short-lived upload tokens are renewed automatically. If Google revokes the
token, the row shows the reason and **Reconnect** starts over. **Disconnect** revokes the token with
Google and deletes it from the environment.

Things to know:

- While the OAuth consent screen is in **Testing** mode, Google expires its sign-in tokens after 7
  days; set it to **In production** to keep the connection. YouTube also keeps videos uploaded
  through an API project that has not passed YouTube's API compliance audit **Private**.
- Uploads have their own daily quota (currently 100 uploads per Google Cloud project per day).
- Videos upload as **Private** unless you choose otherwise. Shorts are ordinary uploads; YouTube
  treats vertical videos up to three minutes long as Shorts automatically.

Tokens stay in the environment's runtime credential storage. They are never sent back to the app or
written to configuration.
