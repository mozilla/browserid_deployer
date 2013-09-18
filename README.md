browserid_deployer
==================

Steps to deploy the deployer:

1. clone & npm install
2. create an awsbox for him.  I.E.

    node_modules/.bin/awsbox create -d -n deployer -u 'https://deployer.personatest.org' \
        -t m1.small -p ~/.allmysecrets/personatest.org/personatest.org.crt \
        -s ~/.allmysecrets/personatest.org/personatest.org.key --ssl=force

3. Provide the VM with the ability to create VMs and manipulate DNS (hopefully this happens with IAM roles)
4. copy the SSL creds to `~app/key.pem` and `~app/cert.pem` (the domain you're deploying to)
5. generate a keypair as the app user - `ssh app@deployer.personatest.org "ssh-keygen -t rsa"`
6. git push deployer HEAD:master

