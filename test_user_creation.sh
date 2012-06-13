#!/usr/bin/env bash 

echo "INSERT INTO user(passwd) values('\$2a\$12\$BTrFTrD03.3CdqxbkUlBlOAlYMXW6vwuIo7Fg.SxPb3lzKOVRkHb2'); INSERT INTO email(user, address, type) VALUES(last_insert_id(), 'webqa.browserid@gmail.com', 'secondary');" | mysql -u browserid browserid
