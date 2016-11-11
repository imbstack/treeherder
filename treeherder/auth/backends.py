import logging
from hashlib import sha1

from django.contrib.auth.models import User
from django.core.exceptions import ObjectDoesNotExist
from taskcluster.sync import Auth
from taskcluster.utils import scope_match

logger = logging.getLogger(__name__)


class TaskclusterAuthBackend(object):
    """
        result of tc_auth.authenticateHawk has the form:

        {'status': 'auth-success',
         'scopes': ['assume:mozilla-group:ateam',
                    'assume:mozilla-group:vpn_treeherder',
                    'assume:mozilla-user:biped@mozilla.com',
                    'assume:mozillians-user:biped',
                    ...
                    'assume:project-admin:ateam',
                    'assume:project-admin:treeherder',
                    'assume:project:ateam:*',
                    'assume:project:treeherder:*',
                    'assume:worker-id:*',
                    'secrets:set:project/treeherder/*'],
         'scheme': 'hawk',
         'clientId': 'mozilla-ldap/biped@mozilla.com',
         'expires': '2016-10-31T17:40:45.692Z'}
    """

    def _get_scope_value(self, result, scope_prefix):
        for scope in result["scopes"]:
            if scope.startswith(scope_prefix):
                return scope[len(scope_prefix):]
        return None

    def _get_email(self, result):
        """Get the user's email from the mozilla-user scope"""
        email = self._get_scope_value(result, "assume:mozilla-user:")

        if not email or email == "*":
            raise TaskclusterAuthenticationFailed(
                "Invalid email for user {} from scope 'assume:mozilla-user': {}".format(
                    result["clientId"], email))
        return email

    def _get_user(self, email):
        """
        Try to find an exising user that matches either the username
        or email.  Prefer the username, since that's the unique key.  But
        fallback to the email.
        """

        # Since there is a unique index on username, but not on email,
        # it is POSSIBLE there could be two users with the same email and
        # different usernames.  Not very likely, but this is safer.
        user = User.objects.filter(email=email)

        # if we didn't find any, then raise an exception so we create a new
        # user
        if not len(user):
            raise ObjectDoesNotExist

        return user.first()

    def authenticate(self, authorization=None, host=None, port=None):
        if not authorization:
            return None

        tc_auth = Auth()
        # see: https://docs.taskcluster.net/reference/platform/auth/api-docs#authenticateHawk
        result = tc_auth.authenticateHawk({
            "authorization": authorization,
            "host": host,
            "port": port,
            "resource": "/",
            "method": "get",
        })

        if result["status"] != "auth-success":
            return None

        # TODO: remove this size limit when we upgrade to django 1.10
        # in Bug 1311967
        email = self._get_email(result)
        sha = sha1()
        sha.update(email)
        username = sha.hexdigest()[-30:]

        try:
            # Find the user by their email.
            user = self._get_user(email)

        except ObjectDoesNotExist:
            # the user doesn't already exist, create it.
            logger.warning("Creating new user: {}".format(username))
            is_staff = scope_match(
                result["scopes"],
                [["assume:project:treeherder:sheriff"]]
            )
            user = User(email=email,
                        username=username,
                        is_staff=is_staff
                        )

        # update the user object in the DB (perhaps Sheriff status
        # or email changed.  This is so that when ``get_user`` is
        # called, it will return the latest is_staff value we got from
        # LDAP.
        user.save()
        return user

    def get_user(self, user_id):
        try:
            return User._default_manager.get(pk=user_id)
        except User.DoesNotExist:
            return None


class TaskclusterAuthenticationFailed(Exception):
    pass
