#!/bin/bash

########################################################################
#                                                                      #
#                   Tripwire Docker Installer Script                   #
#                                                                      #
########################################################################

function getvars {

  while true;do

    echo
    read -p "Please enter the Traefik email: " ADM_EMAIL
    echo ""
    read -p "Please enter the domain name for tripwire: " TRDOMAIN
    echo ""
    read -p "Please enter the mysql ROOT password to be set: " MYSQL_ROOT_PASSWORD
    read -p "Please enter the mysql USER name to be created: " MYSQL_USER
    read -p "Please enter the mysql USER password to be set: " MYSQL_PASSWORD
    echo ""
    read -p "What is the EVE SSE clientID?: " SSO_CLIENT
    read -p "What is the EVE SSE secretID?: " SSO_SECRET

    echo -e "\n\nHere is what you have entered:"
    echo "Traefik email   : $ADM_EMAIL"
    echo "Tripwire domain : $TRDOMAIN"
    echo "mysql root pass : $MYSQL_ROOT_PASSWORD"
    echo "mysql user name : $MYSQL_USER"
    echo "mysql user pass : $MYSQL_PASSWORD"
    echo "EVE SSO clientID: $SSO_CLIENT"
    echo "EVE SSO secretID: $SSO_SECRET"
    echo ""

    read -p "Is this all correct? (yes/no/abort) " yno
    case $yno in
      [Yy]*) dosetup;;
      [Nn]*) continue;;
      [Aa]*) exit 0;;
          *) echo "Try again";;
    esac
  done
}

function dosetup {

  #set up php files
  cp db.inc.docker.example.php db.inc.php
  cp config.example.php config.php

  #write given variables to .env file
  echo "ADM_EMAIL=$ADM_EMAIL" >> .env
  echo "TRDOMAIN=$TRDOMAIN" >> .env
  echo "MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD" >> .env
  echo "MYSQL_USER=$MYSQL_USER" >> .env
  echo "MYSQL_PASSWORD=$MYSQL_PASSWORD" >> .env
  echo "SSO_CLIENT=$SSO_CLIENT" >> .env
  echo "SSO_SECRET=$SSO_SECRET" >> .env

  #set up config
  sed -i -e "s/usernamefromdockercompose/$MYSQL_USER/g; s/userpasswordfromdockercompose/$MYSQL_PASSWORD/g" ./db.inc.php
  sed -i -e "s/\(your domain\|yourdomain\)/$TRDOMAIN/g; s/adminEmail@example.com/$ADM_EMAIL/g; s/client/$SSO_CLIENT/g; s/secret/$SSO_SECRET/g" ./config.php

  #setup traefik
  mkdir -p traefik-data
  touch traefik-data/acme.json
  chmod 600 traefik-data/acme.json

  #add crontab entries
  crontab -l | cat - crontab-tw.txt >/tmp/crontab.txt && crontab /tmp/crontab.txt

  while true;do
      read -p "Would you like to build now? (yes/no) " yno
      case $yno in
          [Yy]*) dobuild;;
          [Nn]*) exit 0;;
              *) echo "Try again";;
      esac
  done
}

function dobuild {
  docker compose --env-file .env up -d --build
  exit
}
getvars
