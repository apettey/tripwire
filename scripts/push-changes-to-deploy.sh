#!/bin/sh

# Rebuild the front end, and if anything changed, push a version update and build onto a deploy branch
# The deploy branch will be [current branch name]-deploy
# It will be overwritten from the current branch

CURRENT_BRANCH=`git rev-parse --abbrev-ref HEAD`
DEPLOY_BRANCH=$CURRENT_BRANCH-deploy
NEW_VERSION=`git describe --tags`

git checkout -B $DEPLOY_BRANCH

# Chain commands so they are all gated on whether public/js and css have changed
(git commit public/js public/css -m "[skip ci] Pipeline - Updated built packages" \
	&& NEW_VERSION=`git describe --tags` && sed "s/'VERSION', '.*'/'VERSION', '$NEW_VERSION'/" -i settings.php \
	&& git commit settings.php --amend --no-edit \
	&& git push -u origin $DEPLOY_BRANCH -f \
	&& echo -e '\033[93mUpdated branch with new build\033[0m' \
) || echo -e '\033[36mNo changes\033[0m'

git checkout $CURRENT_BRANCH
