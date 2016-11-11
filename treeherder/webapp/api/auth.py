import logging

import newrelic.agent
from django.contrib.auth import (authenticate,
                                 login,
                                 logout)
from rest_framework import viewsets
from rest_framework.decorators import list_route
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.response import Response

from treeherder.credentials.models import Credentials
from treeherder.auth.backends import TaskclusterAuthenticationFailed
from treeherder.webapp.api.serializers import UserSerializer

logger = logging.getLogger(__name__)


def hawk_lookup(id):
    try:
        newrelic.agent.add_custom_parameter("hawk_client_id", id)
        credentials = Credentials.objects.get(client_id=id, authorized=True)
    except Credentials.DoesNotExist:
        raise AuthenticationFailed('No authorised credentials found with id %s' % id)

    return {
        'id': id,
        'key': str(credentials.secret),
        'algorithm': 'sha256'
    }


class TaskclusterAuthViewSet(viewsets.ViewSet):

    @list_route()
    def login(self, request):
        """
        Verify credentials with Taskcluster
        """
        authorization = request.META.get("HTTP_OTH", None)

        # when we switch to Django 1.10, use ``get_host`` and ``get_port``
        hostparts = request.META["HTTP_HOST"].split(":")
        host = hostparts[0]
        if "HTTP_X_FORWARDED_PORT" in request.META:
            port = request.META["HTTP_X_FORWARDED_PORT"]
        elif len(hostparts) == 2:
            port = hostparts[1]
        else:
            # default to trying SSL
            port = 443

        try:
            user = authenticate(authorization=authorization,
                                host=host,
                                port=int(port))
            login(request, user)

            return Response(UserSerializer(user).data)
        except TaskclusterAuthenticationFailed as ex:
            raise AuthenticationFailed(ex.message)

    @list_route()
    def logout(self, request):
        logout(request)
        return Response("User logged out")
