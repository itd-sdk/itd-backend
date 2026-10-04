"""itd-sdk exception mapping + advanced flows against the local backend."""
import json, os, time, uuid, urllib.request
from uuid import uuid4
from itd import ITDConfig, init_client, Me, User, Post, File, Sessions, Hashtags
from itd.core.auth import CredentialsAuth
from itd.core.qr import QRLogin
from itd.enums import ReportReason
from itd import exceptions as E
from itd.api.auth import sign_in
from itd.api.posts import get_stats
from itd.api.users import delete_account, restore_account

API = os.environ.get('ITD_API', 'http://localhost:3100/api')
RUN = uuid.uuid4().hex[:6]
PASSWORD = 'supersecret123'
checks = []
def check(label, cond):
    checks.append((label, bool(cond))); print(('OK  ' if cond else 'FAIL'), label)

def expect(label, exc_type, fn):
    try:
        fn()
    except exc_type:
        check(label, True); return
    except Exception as e:
        check(f'{label} (got {type(e).__name__}: {e})', False); return
    check(f'{label} (no exception)', False)

def rest(method, path, body=None, token=None, headers=None):
    req = urllib.request.Request(API + path if path.startswith('/') else path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header('content-type', 'application/json')
    for k, v in (headers or {}).items(): req.add_header(k, v)
    if token: req.add_header('authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req) as r:
        txt = r.read().decode()
        return json.loads(txt) if txt else None

def make_account(name, avatar):
    email = f'{name}_{RUN}'  # Telegram username; the SDK sends it as `email`
    tok = rest('POST', '/v1/auth/sign-up', {'email': email, 'password': PASSWORD})['accessToken']
    rest('POST', '/users/profile', {'username': f'{name}{RUN}', 'displayName': name.title(), 'avatar': avatar}, tok)
    return email

def client_for(email, name):
    return init_client(f'e2e2-{name}-{RUN}', config=ITDConfig(url=API, dwell_send_interval=1, interactive_auth=False), auth=CredentialsAuth(email, PASSWORD, 'x'))

a_email, b_email = make_account('carol', '🐸'), make_account('dave', '🐸')
carol, dave = client_for(a_email, 'carol'), client_for(b_email, 'dave')

# ---- auth errors
expect('InvalidCredentialsError', E.InvalidCredentialsError, lambda: sign_in(carol, a_email, 'wrong-password-1', 'turnstileToken', 'x'))
expect('SamePasswordError', E.SamePasswordError, lambda: carol.change_password(PASSWORD, PASSWORD))
expect('InvalidOldPasswordError', E.InvalidOldPasswordError, lambda: carol.change_password('wrong-old-pass', 'new-password-123'))
expect('InvalidPasswordError', E.InvalidPasswordError, lambda: carol.change_password(PASSWORD, 'short'))
old_access = carol._profile.access
carol.refresh_auth()
check('refresh_auth rotates access token', carol._profile.access != old_access)

# ---- user errors
me_c = Me(carol)
expect('NotFoundError user', E.NotFoundError, lambda: User(f'nobody{RUN}', carol).refresh())
expect('CantFollowYourselfError', E.CantFollowYourselfError, lambda: User(me_c.username, carol).follow())
dave_user = User(f'dave{RUN}', carol)
dave_user.follow()
expect('AlreadyFollowingError', E.AlreadyFollowingError, lambda: User(f'dave{RUN}', carol).follow())
expect('CantBlockYourselfError', E.CantBlockYourselfError, lambda: User(me_c.username, carol).block())
dave_user.block()
expect('AlreadyBlockedError', E.AlreadyBlockedError, lambda: User(f'dave{RUN}', carol).block())
dave_user.unblock()
expect('NotBlockedError', E.NotBlockedError, lambda: User(f'dave{RUN}', carol).unblock())
expect('UsernameTakenError', E.UsernameTakenError, lambda: me_c.update(username=f'dave{RUN}'))
expect('PinNotOwnedError', E.PinNotOwnedError, lambda: me_c.set_pin('__nope__'))
me_c.update(bio='био из sdk', display_name='Кэрол')
check('profile update', Me(carol).bio == 'био из sdk' and Me(carol).display_name == 'Кэрол')

# ---- post errors
own = Post.new('мой пост', client=carol)
expect('CantRepostYourselfError', E.CantRepostYourselfError, lambda: own.repost())
own.repost(client=dave)
expect('AlreadyRepostedError', E.AlreadyRepostedError, lambda: Post(own.id, client=dave).repost())
expect('ForbiddenError edit', E.ForbiddenError, lambda: Post(own.id, client=dave).edit('взлом'))
expect('ForbiddenError delete', E.ForbiddenError, lambda: Post(own.id, client=dave).delete())
expect('NotFoundError post', E.NotFoundError, lambda: Post(uuid4(), client=carol).refresh())
expect('NotPinnedError', E.NotPinnedError, lambda: own.unpin())
expect('ValidationError long post', E.ValidationError, lambda: Post.new('x' * 6000, client=carol))
own.report(ReportReason.SPAM, client=dave)
expect('AlreadyReportedError', E.AlreadyReportedError, lambda: own.report(ReportReason.SPAM, client=dave))
expect('NotFoundError report target', E.NotFoundError, lambda: Post(uuid4(), client=dave).report(ReportReason.SPAM))
c = Post(own.id, client=dave).add_comment('коммент')
expect('ForbiddenError edit comment', E.ForbiddenError, lambda: c.edit('взлом', client=carol))
c.delete(client=carol)  # post owner may delete comments
expect('AlreadyDeletedError comment', E.AlreadyDeletedError, lambda: c.delete(client=dave))

# ---- stats and views (dwell)
viewed = Post(own.id, client=dave)
viewed.view()
dave.dwell_tracker.send_views()
stats = get_stats(dave, [own.id]).json()['posts'][0]
check('dwell view counted', stats['viewsCount'] == 1)
viewed.update_stats()
check('update_stats', viewed.views_count == 1 and viewed.reposts_count == 1)
check('liked posts list', isinstance(User(f'dave{RUN}', carol).liked_posts.load(5), list))
check('hashtag search', isinstance(list(Hashtags.search('sdk')), list))

# ---- subscription & pins
sub = Me(carol).subscription
check('subscription inactive', not sub.active)
url = sub.pay()
check('pay returns url', url.startswith('http'))
confirm = url.split('?')
rest('POST', confirm[0] + '/confirm?' + confirm[1], {}, headers={'accept': 'application/json'})
me_c = Me(carol)
check('subscription active after payment', me_c.subscription.active)
check('auto renewal toggle', me_c.subscription.set_auto_renewal(False) is False)
check('payment methods', len(me_c.subscription.payment_methods) == 1)
check('nuksta pin granted', any(p.slug == 'nuksta' for p in me_c.pins))
me_c.set_pin('nuksta')
check('set pin', Me(carol).pin.slug == 'nuksta')
expect('Subscription NotFound (dave)', E.NotFoundError, lambda: Me(dave).subscription.set_auto_renewal(True))

# ---- video requires subscription
mp4 = bytes.fromhex('000000186674797069736f6d0000020069736f6d69736f32') + b'\x00' * 64
vid = File('clip.mp4', mp4, client=dave)
expect('RequiresSubscriptionError video', E.RequiresSubscriptionError, lambda: Post.new('видео', attachments=vid, client=dave))
expect('InvalidFileTypeError', E.InvalidFileTypeError, lambda: File('note.txt', b'hello world, not media at all', client=dave))

# ---- sessions & account deletion
extra = client_for(b_email, 'dave-2')
check('two sessions', len(Sessions(dave)) >= 2)
check('revoke others', Sessions(dave).revoke_all() >= 1)
deadline = Me(dave).delete()
check('delete account returns deadline', deadline is not None)
expect('AccountDeletedError on Me', E.AccountDeletedError, lambda: Me(dave).refresh())
expect('AlreadyDeletedError account', E.AlreadyDeletedError, lambda: delete_account(dave))
restore_account(dave)
check('restore account', Me(dave).username == f'dave{RUN}')
expect('NotDeletedError', E.NotDeletedError, lambda: restore_account(dave))

# ---- QR login: new device shows QR, a mobile session approves it
mobile_token = rest('POST', '/v1/auth/sign-in', {'email': a_email, 'password': PASSWORD}, headers={'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'})['accessToken']
desktop_token = rest('POST', '/v1/auth/sign-in', {'email': a_email, 'password': PASSWORD})['accessToken']
import itd
from itd.core.client import Client
# QRLogin builds its own anonymous client with the default (production) url
itd.init_not_authed_client = lambda config=None: Client('no-auth', config=ITDConfig(url=API, interactive_auth=False))
qr = QRLogin()
statuses = []
import threading
def approve():
    time.sleep(0.5)
    rest('POST', '/v1/auth/qr/scan', {'qrId': str(qr.qr.id)}, mobile_token)
    time.sleep(0.3)
    try:
        rest('POST', '/v1/auth/qr/approve', {'qrId': str(qr.qr.id)}, desktop_token)
        statuses.append('desktop-approved?!')
    except urllib.error.HTTPError as e:
        statuses.append(f'desktop:{e.code}')
    rest('POST', '/v1/auth/qr/approve', {'qrId': str(qr.qr.id)}, mobile_token)
threading.Thread(target=approve, daemon=True).start()
for status in qr.events():
    statuses.append(status)
check('qr flow', statuses[:1] == ['pending'] and 'scanned' in statuses and statuses[-1] == 'authorized' and 'desktop:403' in statuses)
check('qr auth tokens', qr.auth and qr.auth.access and qr.auth.refresh)

carol.logout()
check('logout', True)

failed = [label for label, ok in checks if not ok]
print(f'\n{len(checks) - len(failed)}/{len(checks)} checks passed')
os._exit(1 if failed else 0)
