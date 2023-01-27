# Installation instructions for dweb-mirror on IIAB on Raspberry Pi 3 or 4

If you not installing dweb-archive+IIAB on a Raspberry Pi then one of these documents 
will be much easier to follow. 

* [INSTALLATION.md](./INSTALLATION.md)
  for general installation instructions.
* [INSTALLATION-dev.md](./INSTALLATION-dev.md) 
  for developers who want to work on this code or on dweb-archive (our offline Javascript UI).
  These are tested on Mac OSX, but should work with only minor changes on Linux (feedback welcome).
* [INSTALLATION-iiab-rpi.md](./INSTALLATION-iiab-rpi.md) 
  to install Internet In A Box on a Rasperry Pi
* [INSTALLATION-iiab-olip.md](./INSTALLATION-olip-rpi.md) 
  to install OLIP on a Rasperry Pi
* [INSTALLATION-rachel.md](./INSTALLATION-rachel.md) 
  for Rachel on their own Rachel 3+ (incomplete)

If anything here doesn't work please email mitra@archive.org
or it would be even more helpful to post a PR on https://github.com/internetarchive/dweb-mirror 

## See also
* [README.md](./README.md) for more general information
* [issue #111](https://github.com/internetarchive/dweb-mirror/issues/111) for meta task for anything IIAB.

## Step 1 Initial setup - getting Raspbian

If your Raspberry Pi comes with Raspbian you are in luck, skip to Step 1B, 
otherwise if it comes with NOOBS (as most do now) you'll need to replace it with Raspbian.

Internet in a Box's site is short on the initial details, especially if your RPi comes with NOOBS as mine did. 
So this is what I did. (Edits welcome, if your experience differed)

* Downloaded Raspbian [Raspbian](https://www.raspberrypi.org/downloads/raspbian/) to your laptop (~1GB)
  * Any of the distributions should work - I test on the Desktop version
* On a Mac:
  * downloaded [Etcher](https://www.balena.io/etcher/) (100Mb)
  * Run Etcher (its supposed to be able to use the zip, though for this test we used the .img from expanding hte zip), selecting a fresh 16GB SD card as the destination
* On Windows or Linux, 
  * I'm not sure the appropriate steps instead of Etcher. 
* Inserted into Raspbian 3 or 4, and powered up with Kbd and HDMI and Mouse inserted. 
* If at all possible insert Ethernet, otherwise it will work over WiFi with some extra steps.
* Power it up
* It prompted me for some getting started things, 
* Accepted "Next to get started" though I suspect IIAB's comprehensive install gets some of them as well.
* Selected your country, language, keyboard - it shouldnt matter which.
* Changed password since RPis get hacked on default password
* Connected to WiFi (not necessary if you have Ethernet connected)
* It automatically Updated OS - this can take a long time - take a break :-)
    * Note that this process failed for me with failures of size and sha, or with timeouts, 
      but a restart, after the prompts for password etc, 
      got me to a partially completed download so I did not have to start from scratch
* You might want to ... Menu/Preferences/Config / Set display to highest resolution
* You probably want `Menu/Raspberry Pi Configuration/Interfaces/SSH enable` so that you can SSH 
  into the box rather than use attached keyboard and screen.

## Step 1B Workaround for Raspbian bug
Raspbian has a bug that requires a patch until they push it to a new release. 
It looks from https://github.com/raspberrypi/linux/issues/3271 like you need to do 
```
sudo rpi-update
```
This should only be applicable until the Raspbian available at 
https://www.raspberrypi.org/downloads/raspbian/
is dated newer than September 2019

## Step 2 Install Internet In A Box

Note its strongly recommended to connect your RPi to the Ethernet, rather than WiFi due to both to speed, 
and some bugs in the IIAB installer

Internet Archive is in the IIAB distribution.

Open a terminal window. 

Run `curl d.iiab.io/install.txt | sudo bash` to install it.
 
To enable it either
a) select the `BIG` distribution, in which case Internet Archive is included 

OR 

b) select `MIN` or `MEDIUM` 
When prompted to edit `/etc/iiab/local_vars.yml` respond `yes` and set the crucial two lines to:
```
internetarchive_install: True
internetarchive_enabled: True
```
and then run `sudo iiab` to continue the installation.

* Update of OS was quick as it probably duplicated the step in the auto-setup above
* expect the isntall to fail, and keep running `sudo iiab` to get it to complete.    
* It will prompt to reset password from default `iiab-admin/g0admin`
* In theory it enables SSH, but sometimes after the OS upgrade to enable it I've had to:
  * login from an attached keyboard, 
  * Preferences > Raspberry Config > Services > SSH > enable

#### Check it worked 

In a browser open: `http://box.lan/admin`   id=`iiab-admin` pw=`whatever you set password to during install`

* Note that I've found that `box.lan` does not work as documented, and that on many setups `box.local` is required instead. 
  See [IIAB Issue#1583](https://github.com/iiab/iiab/issues/1583)
  
Now check dweb-mirror was installed by opening `http://box.local:4244`
  
Also see [http://wiki.laptop.org/go/IIAB/FAQ] if it failed

And if you want to run as a local WiFi hotspot (recommended) then from the ssh prompt..
```
iiab-hotspot-on
```

### 3. Edit configuration

If you are doing anything non-standard, then you'll need to create and edit 
a local configuration file.  Otherwise the application will create it the first time its needed.
```
cd ~/git/dweb-mirror

cp ./dweb-mirror.config.yaml ${HOME} # Copy sample to your home directory and edit, 
```
and edit `$HOME/dweb-mirror.config.yaml` for now see `configDefaults.yaml` for inline documentation.

  * `directories` if you plan on using places other than any of those in dweb-mirror.config.yaml 
  (/.data/archiveorg, and any USBs on Rachel3+, NOOBS or IIAB)
  * `archiveui/directories` you probably do not need to change this as it will usually guess right, 
  but it points to the “dist” subdirectory of wherever dweb-archive is either cloned or installed by npm install.
  * `apps.crawl` includes a structure that lists what collections are to be installed, 
  I suggest testing and then editing
   
Note that directories specified in the config file can be written using shell or unix conventions such as "~/" or "../".

### 4. Test crawling and browsing

#### Crawling
Crawling will happen automatically, but you can also test it manually.

From a command line:
```
cd /opt/iiab/internetarchive//node_modules/@internetarchive/dweb-mirror && sudo ./internetarchive -sc
```
* starts the HTTP server
* It might take 10-15 seconds to start, be patient
* It should start crawling, and get just a minimal set of icons for the home page.
* the startup is a little slow but you'll see some debugging when its live.
* If it reports `ERROR: Directory for the cache is not defined or doesnt exist`
  * then it means you didn't create a directory for it to use as a cache
  * the server wants you to do this, so that it doesn't fill a disk somewhere you don't want it to happen
* If you see a message like `Requeued fetch of https://dweb.archive.org/info failed` then it means it cannot see 
  the archive's servers (on `dweb.archive.org`) so it won't be able to crawl or cache initial material until you 
  connect to the WiFi or Ethernet. 

Without any other arguments, `crawl` will read a set of files into into the first (already existing) directory
configured in `~/dweb-mirror.config.yaml` 
or if there are none there, it will look in its installation directory for `configDefaults.yaml`.

Look in that directory, and there should be sub-directories appearing for each item, with metadata and/or thumbnails.

You can safely delete any of the crawled material and it will be re-fetched if needed.

#### Browsing
* In a browser try going to `http://localhost:4244` 
* Or from another machine: `http://archive.local:4244` or `http://<IP of your machine>:4244`
* open http://localhost:4244/details/prelinger?transport=HTTP&mirror=localhost:4244
to see the test crawl.

If you don’t get a Archive UI then look at the server log 
```
service internetarchive status
```
Will get the status and most recent lines
```
journalctl -u internetarchive -f
```
will watch the log, `Ctrl-C` will end this.

Look for any “FAILING” log lines which indicate a problem

Expect to see errors in the Browser log for 
* http://localhost:5001/api/v0/version?stream-channels=true  - which is checking for a local IPFS server

Expect, on slower machines/networks, to see no images the first time, 
refresh after a little while and most should appear. 

## 7. Auto-starting
IIAB will start the internetarchive server each time it reboots.

## 8. Updating

The software is frequently revised so its recommended to update, especially if you see any bugs or problems.

```
cd /opt/iiab/iiab
git pull
./runrole --reinstall internetarchive
```
