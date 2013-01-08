/*global document, window, Cesium, Image, navigator, twoline2rv, sgp4, tle*/
(function () {
    'use strict';
    var canvas          = document.getElementById('glCanvas');
    var ellipsoid       = Cesium.Ellipsoid.WGS84;
    var scene           = new Cesium.Scene(canvas);
    var satBillboards   = new Cesium.BillboardCollection();
    var cb              = new Cesium.CentralBody(ellipsoid);
    var clock           = new Cesium.Clock();
    var orbitTraces     = new Cesium.PolylineCollection(); // currently only one at a time
    var satrecs         = [];   // populated from onclick file load
    var satPositions    = [];   // calculated by updateSatrecsPosVel()
    var satData         = [];   // list of satellite data and metadata
    // Constants
    var skyboxBase      = "static/images/skybox";
    var SAT_POSITIONS_MAX = 10; // Limit numer of positions displayed to save CPU
    var CALC_INTERVAL_MS  = 1000;
    // HACK: force globals for SGP4
    var WHICHCONST      = 84;   //
    var TYPERUN         = 'm';  // 'm'anual, 'c'atalog, 'v'erification
    var TYPEINPUT       = 'n';  // HACK: 'now'

    ///////////////////////////////////////////////////////////////////////////
    // Tile Providers

    var TILE_PROVIDERS = {
        'bing' : new Cesium.BingMapsImageryProvider(// fails to detect 404 due to no net :-(
            {server : 'dev.virtualearth.net',
             mapStyle: Cesium.BingMapsStyle.AERIAL_WITH_LABELS
            }),
        'osm'  : new Cesium.OpenStreetMapImageryProvider(
            {url    : 'http://otile1.mqcdn.com/tiles/1.0.0/osm'
            }),
        'static' : new Cesium.SingleTileImageryProvider(
            {url: 'Images/NE2_50M_SR_W_4096.jpg'
            })
        // Cross-origin image load denied by Cross-Origin Resource Sharing policy.
        // 'arcgis' : new Cesium.ArcGisMapServerImageryProvider(
        //     {url: 'http://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
        //     })
    };


    ///////////////////////////////////////////////////////////////////////////
    // Satellite records and calculation

    // Read TLEs from file and set GLOBAL satrecs, names, noradId and intlDesig.
    // We can then run the SGP4 propagator over it and render as billboards.

    function getSatrecsFromTLEFile(fileName) {
        var tles = tle.parseFile(fileName);
        var satnum, max, rets, satrec, startmfe, stopmfe, deltamin;

        // Reset the globals
        satrecs = [];
        satData = [];

        for (satnum = 0, max = tles.length; satnum < max; satnum += 1) {
            satData[satnum] = {
                name:      tles[satnum][0].trim(), // Name: (ISS (ZARYA))
                intlDesig: tles[satnum][1].slice(9, 17), // Intl Designator YYNNNPPP (98067A)
                noradId:   tles[satnum][2].split(' ')[1], // NORAD ID (25544)
                // should parse and store the bits we want, but save string for now
                tle0: tles[satnum][0],
                tle1: tles[satnum][1],
                tle2: tles[satnum][2],

                };

            rets = twoline2rv(WHICHCONST, tles[satnum][1], tles[satnum][2], TYPERUN, TYPEINPUT);
            satrec   = rets.shift();
            startmfe = rets.shift();
            stopmfe  = rets.shift();
            deltamin = rets.shift();
            satrecs.push(satrec); // Don't need to sgp4(satrec, 0.0) to initialize state vector
        }
        // Returns nothing, sets globals: satrecs, satData
    }

    // Calculate new Satrecs based on time given as fractional Julian Date
    // (since that's what satrec stores).
    // Return object containing updated list of Satrecs, Rposition, Velocity.
    // We don't have r (position) or v (velocity) in the satrec,
    // so we have to return a those as a list as well; ugly.
    // XXX Should I just add position and velocity to the satrec objects?

    function updateSatrecsPosVel(satrecs, julianDate) {
        var satrecsOut = [];
        var positions = [];
        var velocities = [];
        var satnum, max, satrecTmp, jdSat, minutesSinceEpoch, rets, satrec, r, v;

        for (satnum = 0, max = satrecs.length; satnum < max; satnum += 1) {
            satrecTmp = satrecs[satnum];
            jdSat = new Cesium.JulianDate.fromTotalDays(satrecTmp.jdsatepoch);
            minutesSinceEpoch = jdSat.getMinutesDifference(julianDate);
            rets = sgp4(satrecs[satnum], minutesSinceEpoch);
            satrec = rets.shift();
            r = rets.shift();      // [1802,    3835,    5287] Km, not meters
            v = rets.shift();
            satrecsOut.push(satrec);
            positions.push(r);
            velocities.push(v);
        }
        // UPDATE GLOBAL SO OTHERS CAN USE IT (TODO: make this sane w.r.t. globals)
        satPositions = positions;
        return {'satrecs': satrecsOut,
                'positions': positions,
                'velocities': positions};
    }

    // Update the location of each satellite in the billboard.
    // The calculated position is in Km but Cesium wants meters.
    // The satellite's icon (from TextureAtlas) and name are already set
    // by populateSatelliteBillboard().

    function updateSatelliteBillboards(satPositions) {
        var now = new Cesium.JulianDate();
        var posnum, max, pos, newpos, bb;

        satBillboards.modelMatrix =
            Cesium.Matrix4.fromRotationTranslation(
                Cesium.Transforms.computeTemeToPseudoFixedMatrix(now),
                Cesium.Cartesian3.ZERO);
        for (posnum = 0, max = satPositions.length; posnum < max; posnum += 1) {
            bb = satBillboards.get(posnum);
            pos = satPositions[posnum];
            newpos =  new Cesium.Cartesian3(pos[0] * 1000, pos[1] * 1000, pos[2] * 1000); // TODO multiplyByScalar(1000)
            bb.setPosition(newpos);
        }
    }

    // Load the satellite names and keys into the selector, sorted by name

    function populateSatelliteSelector() {
        var satSelect = document.getElementById('select_satellite');
        var nameIdx = {};
        var satnum, max, option, satkeys;

        for (satnum = 0, max = satrecs.length; satnum < max; satnum += 1) {
            nameIdx[satData[satnum].name] = satnum;
        }
        satkeys = Object.keys(nameIdx);
        satkeys.sort();
        satSelect.innerHTML = ''; // $('select_satellite').empty();
        option = document.createElement('option');
        satSelect.appendChild(option); // first is empty to not select any satellite
        for (satnum = 0, max = satkeys.length; satnum < max; satnum += 1) {
            option = document.createElement('option');
            option.textContent = satkeys[satnum];
            option.value = nameIdx[satkeys[satnum]];
            satSelect.appendChild(option);
        }
    }

    // Create a new billboard for the satellites which are updated frequently.
    // These are placed in the global satellite billboard, replacing any old ones.
    // Keep it distict from other billboards, e.g., GeoLocation, that don't change.
    // We don't need to set position here to be actual, it'll be updated in the time-loop.
    // TODO: should this be combined with the populateSatelliteSelector()?

    function populateSatelliteBillboard() {
        var satnum, max, billboard;
        var image = new Image();

        satBillboards.removeAll(); // clear out the old ones
        for (satnum = 0, max = satData.length; satnum < max; satnum += 1) {
            billboard = satBillboards.add({imageIndex: 0,
                                           position:  new Cesium.Cartesian3(0, 0, 0)}); // BOGUS position
            // attach names for mouse interaction
            // TODO: just attach satData[satnum] and let JS display the attrs it wants?
            billboard.satelliteName       = satData[satnum].name;
            billboard.satelliteNoradId    = satData[satnum].noradId;
            billboard.satelliteDesignator = satData[satnum].intlDesig;
        }
        scene.getPrimitives().add(satBillboards);

        image.src = 'Images/Satellite.png';
        image.onload = function () {
            var textureAtlas = scene.getContext().createTextureAtlas({image: image}); // seems needed in onload()
            satBillboards.setTextureAtlas(textureAtlas);
        };
    }

    ///////////////////////////////////////////////////////////////////////////
    // Geo: put a cross where we are, if the browser is Geo-aware

    function showGeolocation(scene) {
        function showGeo(position) {
            var target = ellipsoid.cartographicToCartesian( // TODO: should this be 0, 0, 0 through Geolocation?
                Cesium.Cartographic.fromDegrees(position.coords.longitude, position.coords.latitude));
            var eye    = ellipsoid.cartographicToCartesian(
                Cesium.Cartographic.fromDegrees(position.coords.longitude, position.coords.latitude, 1e7));
            var up     = new Cesium.Cartesian3(0, 0, 1);
            // Put a cross where we are
            var image = new Image();
            image.src = 'Images/icon_geolocation.png';
            image.onload = function () {
                var billboards = new Cesium.BillboardCollection(); // how to make single?
                var textureAtlas = scene.getContext().createTextureAtlas({image: image});
                billboards.setTextureAtlas(textureAtlas);
                billboards.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(target);
                billboards.add({imageIndex: 0,
                                position: new Cesium.Cartesian3(0.0, 0.0, 0.0)});
                scene.getPrimitives().add(billboards);
            };
            // Point the camera at us and position it directly above us
            scene.getCamera().controller.lookAt(eye, target, up);
        }
        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(showGeo);
        }
    }

    ///////////////////////////////////////////////////////////////////////////
    // Utilities

    // Convert TLE name to something science.nasa.gov might use in Mission URLs.
    // How do we handle reliably?
    // Note: doesn't adhere to Django slugify() naming.
    // * TOPEX/POSEIDON -> topex-poseidon
    // * HINODE (SOLAR-B) -> hinode

    function scienceSlugify(value) {
        value = value.trim().toLowerCase();
        value = value.split('(')[0].trim(); // remove anything in trailing parens
        value = value.replace('/', '-');    // topex/poseidon -> topex-poseidon
        value = value.replace(/[^\w\s\-]/, ''); // remove nonword, nonspace, nondash
        value = value.replace(/[\-\s]+/, '-'); // multiple spaces/dashes to a single dash
        return value;
    }

    // Function xyzKmFixed(pt, fix) {
    //     // Return string formatted for xyz scaled to Km, with fixed precision.
    //     return '(' +
    //         (pt.x / 1000.0).toFixed(fix) + ', ' +
    //         (pt.y / 1000.0).toFixed(fix) + ', ' +
    //         (pt.z / 1000.0).toFixed(fix) + ', ' +
    //         ')';
    // }

    ///////////////////////////////////////////////////////////////////////////
    // Handle UI events

    // If the screen is resized, set animation window to a square 95% of width,
    // which leaves some room for scrollbars (else you end up zooming).
    // In <canvas> tag our height and width can only be in pixels, not percent.
    // So wrap it in a div whose height/width we can query.

    function getScrollBarWidth () {
        // getScrollBarWidth
        // http://www.alexandre-gomes.com/?p=115
        //
        // Gives me scrollbar width for multi-browser support.
        //
        var inner = document.createElement('p');
        inner.style.width = "100%";
        inner.style.height = "200px";

        var outer = document.createElement('div');
        outer.style.position = "absolute";
        outer.style.top = "0px";
        outer.style.left = "0px";
        outer.style.visibility = "hidden";
        outer.style.width = "200px";
        outer.style.height = "150px";
        outer.style.overflow = "hidden";
        outer.appendChild (inner);

        document.body.appendChild (outer);
        var w1 = inner.offsetWidth;
        outer.style.overflow = 'scroll';
        var w2 = inner.offsetWidth;
        if (w1 == w2) w2 = outer.clientWidth;

        document.body.removeChild (outer);

        return (w1 - w2);
    }

    function onResize() {
        var nav_width = document.getElementById('nav').scrollWidth;
        var headerHeight = document.getElementById('header').scrollHeight;
        var width = window.innerWidth - nav_width - getScrollBarWidth();
        var height = window.innerHeight - headerHeight;     // 800x600 minus header
        // var height = cc.scrollHeight;
        if (canvas.width === width && canvas.height === height) {
            return;
        }
        canvas.width = width;
        canvas.height = height;
        var cc = document.getElementById('cesiumContainer');
        cc.width = width;
        cc.height = height;
        scene.getCamera().frustum.aspectRatio = width / height;
    }
    window.addEventListener('resize', onResize, false);
    onResize();


    // Button actions
    document.getElementById('reset_button').onclick = function () {
        window.location.reload();
    };

        // Button actions
    document.getElementById('instruction_button').onclick = function () {
        if (document.getElementById('nav').style.display == 'none') {
            document.getElementById('nav').style.display = 'block';
            document.getElementById('instructions').style.display = 'block';
            document.getElementById('reset_button').style.left = '410px';
            document.getElementById('instruction_button').style.left = '470px';
            document.getElementById('display_button').style.left = '530px';
            document.getElementById('three_d_display_button').style.left = '530px';
            document.getElementById('columbus_display_button').style.left = '530px';
            document.getElementById('two_d_display_button').style.left = '530px';
            document.getElementById('satellite_button').style.left = '590px';
            document.getElementById('live_data_button').style.left = '650px';
            document.getElementById('bing_data_button').style.left = '650px';
            document.getElementById('osm_data_button').style.left = '650px';
            document.getElementById('static_data_button').style.left = '650px';
            onResize();
        }
        else {
            document.getElementById('nav').style.display = 'none';
            document.getElementById('instructions').style.display = 'none';
            document.getElementById('reset_button').style.left = '10px';
            document.getElementById('instruction_button').style.left = '70px';
            document.getElementById('display_button').style.left = '130px';
            document.getElementById('three_d_display_button').style.left = '130px';
            document.getElementById('columbus_display_button').style.left = '130px';
            document.getElementById('two_d_display_button').style.left = '130px';
            document.getElementById('satellite_button').style.left = '190px';
            document.getElementById('live_data_button').style.left = '250px';
            document.getElementById('bing_data_button').style.left = '250px';
            document.getElementById('osm_data_button').style.left = '250px';
            document.getElementById('static_data_button').style.left = '250px';
            onResize();
        }
    };

    document.getElementById('instruction_close').onclick = function () {
        document.getElementById('nav').style.display = 'none';
        document.getElementById('instructions').style.display = 'none';
        document.getElementById('reset_button').style.left = '10px';
        document.getElementById('instruction_button').style.left = '70px';
        document.getElementById('display_button').style.left = '130px';
        document.getElementById('three_d_display_button').style.left = '130px';
        document.getElementById('columbus_display_button').style.left = '130px';
        document.getElementById('two_d_display_button').style.left = '130px';
        document.getElementById('satellite_button').style.left = '190px';
        document.getElementById('live_data_button').style.left = '250px';
        document.getElementById('bing_data_button').style.left = '250px';
        document.getElementById('osm_data_button').style.left = '250px';
        document.getElementById('static_data_button').style.left = '250px';
        onResize();
    };

    document.getElementById('display_button').onclick = function() {
        if (document.getElementById('three_d_display_button').style.display == 'none') {
            document.getElementById('three_d_display_button').style.display = 'block';
            document.getElementById('columbus_display_button').style.display = 'block';
            document.getElementById('two_d_display_button').style.display = 'block';
        } else {
            document.getElementById('three_d_display_button').style.display = 'none';
            document.getElementById('columbus_display_button').style.display = 'none';
            document.getElementById('two_d_display_button').style.display = 'none';
        }
    };

    document.getElementById('satellite_button').onclick = function () {
        if (document.getElementById('nav').style.display == 'none') {
            document.getElementById('nav').style.display = 'block';
            document.getElementById('nav_buttons').style.display = 'block';
            document.getElementById('reset_button').style.left = '410px';
            document.getElementById('instruction_button').style.left = '470px';
            document.getElementById('display_button').style.left = '530px';
            document.getElementById('three_d_display_button').style.left = '530px';
            document.getElementById('columbus_display_button').style.left = '530px';
            document.getElementById('two_d_display_button').style.left = '530px';
            document.getElementById('satellite_button').style.left = '590px';
            document.getElementById('live_data_button').style.left = '650px';
            document.getElementById('bing_data_button').style.left = '650px';
            document.getElementById('osm_data_button').style.left = '650px';
            document.getElementById('static_data_button').style.left = '650px';
            onResize();
        }
        else {
            document.getElementById('nav').style.display = 'none';
            document.getElementById('nav_buttons').style.display = 'none';
            document.getElementById('reset_button').style.left = '10px';
            document.getElementById('instruction_button').style.left = '70px';
            document.getElementById('display_button').style.left = '130px';
            document.getElementById('three_d_display_button').style.left = '130px';
            document.getElementById('columbus_display_button').style.left = '130px';
            document.getElementById('two_d_display_button').style.left = '130px';
            document.getElementById('satellite_button').style.left = '190px';
            document.getElementById('live_data_button').style.left = '250px';
            document.getElementById('bing_data_button').style.left = '250px';
            document.getElementById('osm_data_button').style.left = '250px';
            document.getElementById('static_data_button').style.left = '250px';
            onResize();
        }
    };

    document.getElementById('satellite_close').onclick = function () {
        document.getElementById('nav').style.display = 'none';
        document.getElementById('instructions').style.display = 'none';
        document.getElementById('reset_button').style.left = '10px';
        document.getElementById('instruction_button').style.left = '70px';
        document.getElementById('display_button').style.left = '130px';
        document.getElementById('three_d_display_button').style.left = '130px';
        document.getElementById('columbus_display_button').style.left = '130px';
        document.getElementById('two_d_display_button').style.left = '130px';
        document.getElementById('satellite_button').style.left = '190px';
        document.getElementById('live_data_button').style.left = '250px';
        document.getElementById('bing_data_button').style.left = '250px';
        document.getElementById('osm_data_button').style.left = '250px';
        document.getElementById('static_data_button').style.left = '250px';
        onResize();
    };

    document.getElementById('live_data_button').onclick = function() {
        if (document.getElementById('bing_data_button').style.display == 'none') {
            document.getElementById('bing_data_button').style.display = 'block';
            document.getElementById('osm_data_button').style.display = 'block';
            document.getElementById('static_data_button').style.display = 'block';
        } else {
            document.getElementById('bing_data_button').style.display = 'none';
            document.getElementById('osm_data_button').style.display = 'none';
            document.getElementById('static_data_button').style.display = 'none';
        }
    };


    // When you hover over a satellite, show its name in a popup
    // Add offset of canvas and an approx height of icon/label to position properly.
    // TODO: make offset based on label text height so cursor doesn't occlude.
    // TODO: scene and ellipsoid are global so why pass them in?

    function satelliteHoverDisplay(scene) {
        var handler = new Cesium.ScreenSpaceEventHandler(scene.getCanvas());

        handler.setInputAction( // actionFunction, mouseEventType, eventModifierKey
            function (movement) {
                var pickedObject = scene.pick(movement.endPosition);
                var satDiv = document.getElementById('satellite_popup');
                var canvasTop = canvas.offsetTop;
                if (pickedObject && pickedObject.satelliteName) { // Only show satellite, not Geo marker
                    satDiv.textContent = pickedObject.satelliteName;
                    satDiv.style.left = movement.endPosition.x + 'px';
                    satDiv.style.top  = movement.endPosition.y + canvasTop - 24 + 'px'; // seems a bit high from mouse
                    satDiv.style.display = ''; // remove any 'none'
                    // The following used to work in <style> section, but stopped; why?
                    satDiv.style.position = 'absolute'; // vital to positioning near cursor
                    satDiv.style.padding = '2px';
                    satDiv.style.backgroundColor = '#909090';
                    satDiv.style.color = 'black';
                }
                else {
                    satDiv.style.display = 'none';
                }
            },
            Cesium.ScreenSpaceEventType.MOUSE_MOVE // MOVE, WHEEL, {LEFT|MIDDLE|RIGHT}_{CLICK|DOUBLE_CLICK|DOWN|UP}
        );
    }

    // Clicking a satellite opens a page to Sciencce and NSSDC details

    function satelliteClickDetails(scene) {
        var handler = new Cesium.ScreenSpaceEventHandler(scene.getCanvas());

        handler.setInputAction( // actionFunction, mouseEventType, eventModifierKey
            function (click) {
                var pickedObject = scene.pick(click.position);
                var scienceUrl = 'http://science.nasa.gov/missions/';
                var nssdcUrl = 'http://nssdc.gsfc.nasa.gov/nmc/spacecraftDisplay.do?id=';
                var satName, satDesig, century;

                if (pickedObject) {
                    satName  = pickedObject.satelliteName.toLowerCase();
                    satDesig = pickedObject.satelliteDesignator;
                    if (typeof window !== 'undefined') {
                        scienceUrl +=  scienceSlugify(satName) + '/';
                        window.open(scienceUrl, '_science');
                        // mangle Intl Designator for NSSDC: 98067A -> 1998-067A
                        if (Number(satDesig.slice(0, 2)) < 20) { // heuristic from JTrack3D source code
                            century = '20';
                        }
                        else {
                            century = '19';
                        }
                        nssdcUrl += century + satDesig.slice(0, 2) + '-' + satDesig.slice(2);
                        window.open(nssdcUrl, '_nssdc');
                    }
                }
            },
            Cesium.ScreenSpaceEventType.LEFT_CLICK // MOVE, WHEEL, {LEFT|MIDDLE|RIGHT}_{CLICK|DOUBLE_CLICK|DOWN|UP}
        );
    }


    // Highlight satellite billboard when selector pulldown used;
    // open a new window (Pop Up) that shows Science.nasa.gov's info about it.
    //
    // We attach an attribute so we can detect any previously highlighted satellite.
    // Updates one of the global satBillboard elements, resets others.
    // The setColor changes icon wings from blue to green.
    // Maybe we should replace the icon by fiddling the textureAtlas index
    // but that would require more images in the textureAtlas.

    document.getElementById('select_satellite').onchange = function () {
        var satIdx = Number(this.value); // "16"
        var target = Cesium.Cartesian3.ZERO;
        var up     = new Cesium.Cartesian3(0, 0, 1);
        var billboard, bbnum, max, pos, eye;

        for (bbnum = 0, max = satBillboards.getLength(); bbnum < max; bbnum += 1) {
            billboard = satBillboards.get(bbnum);
            if (billboard.hasOwnProperty('isSelected')) {
                delete billboard.isSelected;
                billboard.setColor({red: 1, blue: 1, green: 1, alpha: 1});
                billboard.setScale(1.0);
            }
            if (bbnum === satIdx) {
                billboard = satBillboards.get(satIdx);
                billboard.isSelected = true;
                billboard.setColor({red: 1, blue: 0, green: 1, alpha: 1});
                billboard.setScale(2.0);
                pos = billboard.getPosition(); // Cartesian3, but what coordinate system?
            }
        }
        // TODO: *fly* to 'above' the satellite still looking at Earth
        // Transform to put me "over" satellite location.
        scene.getCamera().transform = Cesium.Matrix4.fromRotationTranslation(
            Cesium.Transforms.computeTemeToPseudoFixedMatrix(new Cesium.JulianDate()),
            Cesium.Cartesian3.ZERO);
        eye =  new Cesium.Cartesian3.clone(pos);
        eye = eye.multiplyByScalar(1.5); // Zoom out a bit from the satellite
        scene.getCamera().controller.lookAt(eye, target, up);

        // TODO TMP: draw orbit, since we have the satIdx (not just a BB as we get in hover)
        showOrbit(satIdx);
    };


    // For the given satellite, calculate points for one orbit, starting 'now'
    // and create a polyline to visualize it.
    // It does this by copying the satrec then looping over it through time.
    //
    // TODO: How to find the satIdx on a CLICK event?
    // TODO: the position loop repeats much of updateSatrecsPosVel()
    //
    // The TLE.slice(52, 63) is Mean Motion, Revs per day, e.g., ISS=15.72125391
    // ISS (ZARYA)
    // 1 25544U 98067A   08264.51782528 −.00002182  00000-0 -11606-4 0  2927
    // 2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537
    // We can invert that to get the time time we need for one rev.
    // But it's not our satrec, and we are't storing parsed TLEs.
    // satrec.no is TLE.slice(51,63) / xpdotp in radians/minute; it's manipulated by SGP4 but OK.
    // ISS no=0.06767671366760845
    // To get full 'circle' = 2*Pi => minutes/orbit = 2*Pi / satrec.no = 92.84 minutes for ISS
    // Compare with TLE 15.721.. revs/day:
    // 24 hr/day * 60 min/hr / 15.72125391 rev/day = 91.59574 minutes/rev -- close (enough?)

    function showOrbit(satIdx) {
        var positions = [];
        var satrec = satrecs[satIdx];
        var jdSat = new Cesium.JulianDate.fromTotalDays(satrec.jdsatepoch);
        var now = new Cesium.JulianDate(); // TODO: we'll want to base on tick and time-speedup
        var minutesPerOrbit = 2 * Math.PI / satrec.no;
        var pointsPerOrbit = 144; // arbitrary: should be adaptive based on size (radius) of orbit
        var minutesPerPoint = minutesPerOrbit / pointsPerOrbit;
        var minutes, julianDate, minutesSinceEpoch, rets, r, position;

        orbitTraces.modelMatrix =
            Cesium.Matrix4.fromRotationTranslation(
                Cesium.Transforms.computeTemeToPseudoFixedMatrix(now),
                Cesium.Cartesian3.ZERO);

        for (minutes = 0; minutes <= minutesPerOrbit; minutes += minutesPerPoint) {
            julianDate = now.addMinutes(minutes);
            minutesSinceEpoch = jdSat.getMinutesDifference(julianDate);
            rets = sgp4(satrec, minutesSinceEpoch);
            satrec = rets.shift();
            r = rets.shift();      // [1802,    3835,    5287] Km, not meters
            position = new Cesium.Cartesian3(r[0], r[1], r[2]);  // becomes .x, .y, .z
            position = position.multiplyByScalar(1000); // Km to meters
            positions.push(position);
        }
        orbitTraces.removeAll();
        orbitTraces.add({positions: positions,
                         color: {red: 1, green: 1, blue: 0, alpha: 0.7}});

    }


    // Switch map/tile providers
    //
    // TODO .removeAll() doesn't seem optimal but .remove(0) doesn't seem to work.
    // Should we toggle the Provider's .show attr? how then to add new ones sanely?
    // and not exhaust resources by having a bunch of providers and their tiles?
    function switchTileProviders (provider) {
        var ilNew = TILE_PROVIDERS[provider];
        if (ilNew) {
            cb.getImageryLayers().removeAll();
            cb.getImageryLayers().addImageryProvider(ilNew);
        }
    }
    document.getElementById("bing_data_button").onclick = function () {
        switchTileProviders("bing");
    };

    document.getElementById('osm_data_button').onclick = function () {
        switchTileProviders("osm");
    };

    document.getElementById('static_data_button').onclick = function () {
        switchTileProviders("static");
    };

    // document.getElementById('select_tile_provider').onchange = function () {
    //     var ilNew = TILE_PROVIDERS[this.value];
    //     if (ilNew) {
    //         cb.getImageryLayers().removeAll();
    //         cb.getImageryLayers().addImageryProvider(ilNew);
    //     }
    // };

    // Transition between views

    document.getElementById("three_d_display_button").onclick = function () {
        var transitioner = new Cesium.SceneTransitioner(scene);
        transitioner.to3D();
    };

    document.getElementById('columbus_display_button').onclick = function () {
        var transitioner = new Cesium.SceneTransitioner(scene);
        transitioner.toColumbusView();
    };

    document.getElementById('two_d_display_button').onclick = function () {
        var transitioner = new Cesium.SceneTransitioner(scene);
        transitioner.to2D();
    };

    // document.getElementById('select_view').onchange = function () {
    //     var transitioner = new Cesium.SceneTransitioner(scene);
    //     switch (this.value.toUpperCase()) {
    //     case '2D':
    //         transitioner.to2D();//morphTo2D();
    //         break;
    //     case '2.5D':
    //         transitioner.toColumbusView(); // morphToColumbusView();
    //         break;
    //     case '3D':
    //         transitioner.to3D();//morphTo3D();
    //         break;
    //     default:
    //         break;
    //     }
    // };

    // Switch which satellites are displayed.
    document.getElementById('select_satellite_group').onchange = function () {
        orbitTraces.removeAll();
        getSatrecsFromTLEFile('tle/' + this.value + '.txt'); // TODO: security risk?
        populateSatelliteSelector();
        populateSatelliteBillboard();
    };


    ///////////////////////////////////////////////////////////////////////////
    // Fire it up

    // How do we tell if we can't get Bing, and substitute flat map with 'single'?
    cb.getImageryLayers().addImageryProvider(TILE_PROVIDERS.bing); // TODO: get from HTML selector

    scene.getPrimitives().setCentralBody(cb);
    scene.skyBox = new Cesium.SkyBox({
        positiveX: skyboxBase + '/tycho8_px_80.jpg',
        negativeX: skyboxBase + '/tycho8_mx_80.jpg',
        positiveY: skyboxBase + '/tycho8_py_80.jpg',
        negativeY: skyboxBase + '/tycho8_my_80.jpg',
        positiveZ: skyboxBase + '/tycho8_pz_80.jpg',
        negativeZ: skyboxBase + '/tycho8_mz_80.jpg'
    });
    scene.getPrimitives().add(orbitTraces);

    //scene.getCamera().getControllers().get(0).spindleController.constrainedAxis = Cesium.Cartesian3.UNIT_Z;
    scene.getCamera().controller.lookAt(new Cesium.Cartesian3(4000000.0, -15000000.0,  10000000.0), // eye
                             Cesium.Cartesian3.ZERO, // target
                             new Cesium.Cartesian3(-0.1642824655609347, 0.5596076102188919, 0.8123118822806428)); // up

    showGeolocation(scene);

    getSatrecsFromTLEFile('tle/' + document.getElementById('select_satellite_group').value + '.txt');
    populateSatelliteSelector();
    populateSatelliteBillboard();
    satelliteHoverDisplay(scene); // should be self-invoked
    satelliteClickDetails(scene); // should be self-invoked

    /////////////////////////////////////////////////////////////////////////////
    // Run the timeclock, drive the animations

    var satelliteTimer = setInterval(function () {
        var now = new Cesium.JulianDate(); // TODO> we'll want to base on tick and time-speedup

        if (satrecs.length > 0) {
            var sats = updateSatrecsPosVel(satrecs, now); // TODO: sgp4 needs minutesSinceEpoch from timeclock
            satrecs = sats.satrecs;                       // propagate [GLOBAL]
            updateSatelliteBillboards(sats.positions);
        }
    }, CALC_INTERVAL_MS);


    function animate() {
        // Code here updates primitives based on time, camera position, etc
        // We're updating positions and date with an interval timer,
        // and those are global, so the animation renderer gets them automatically.
    };

    // Loop the clock

    (function tick() {
        scene.initializeFrame(); // takes optional 'time' argument
        //animate();
        scene.render();
        Cesium.requestAnimationFrame(tick);
    }());

}());
