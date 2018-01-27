import { loadModules } from "esri-loader";
import * as L from 'leaflet';
import * as esri from 'esri-leaflet';
import { env } from "../env.js";
import * as Clarifai from "clarifai";
import * as $ from "jquery";

export default {
  data () {
    return {
      mode: "results",
      searchResults: [],
      sample_locations: [{
        name: 'Ships',
        location: [22.3041396, 114.1255438],
        zoom: 18
      }, {
        name: 'Storage Tanks',
        location: [30.0546231, -90.6018915],
        zoom: 18
      }, {
        name: 'Pivot Irrigation',
        location: [22.6903733, 28.3971836],
        zoom: 15
      }],
      map_curr_zoom: 18,
      active_tile_cache: [],
      inactive_tile_cache: [],
      ml_model_id: ''
    };
  },
  mounted () {
    // loadModules(this.modules).then(this.createMap);
    const app = new Clarifai.App({
     apiKey: env.CLARIFAI_TOKEN
    });
    const self = this;

    self.ml_model_id = env.MODEL_ID;
    var map = L.map('mapView').setView(this.sample_locations[0].location, this.sample_locations[0].zoom);
    self.map_curr_zoom = map.getZoom();
    window.map = map;
    esri.tiledMapLayer({
      url: "https://tiledbasemaps.arcgis.com/arcgis/rest/services/World_Imagery/MapServer?token="+env.ESRI_APP_TOKEN
    }).addTo(map);

    // create & add gridlayer
    L.GridLayer.GridDebug = L.GridLayer.extend({
      createTile: function (coords) {
        const tile = document.createElement('div');
        tile.classList.add("tile");
        var coords_id = [coords.z, coords.x, coords.y].join('_');
        var tile_id = "tile_"+coords_id;
        tile.setAttribute("id", tile_id);
        
        // calculate lat/long
        var nwPoint = coords.scaleBy(this.getTileSize());
        var nw = map.unproject(nwPoint, coords.z)
        tile.setAttribute("lat", nw.lat);
        tile.setAttribute("lng", nw.lng);
        // console.log('tile: '+coords_id+ ' lat: '+nw.lat+' lng: '+nw.lng);
        tile.innerHTML = coords.z+", "+coords.y+", "+coords.x+"<br/>"+nw.lat+", "+nw.lng;

        if (self.mode === "results") {
          if (self.active_tile_cache.includes(tile_id)) {
            tile.classList.add("tile_active");
          } else if (self.active_tile_cache.length > 0 && !self.inactive_tile_cache.includes(tile_id)) {
            // not in either caches then run predict/inference on this unseen tile
            // should be optimized to a worker queue
            predictTile(coords.z, coords.y, coords.x);
          }
        } else {
          if (self.active_tile_cache.includes(tile_id)) {
            tile.classList.add("tile_active_train");
          }
        }
        return tile;
      },
    });
    L.gridLayer.gridDebug = function (opts) {
      return new L.GridLayer.GridDebug(opts);
    };
    var grid_layer = L.gridLayer.gridDebug();
    window.grid_layer = grid_layer;

    $('#mapView').on('click', '.tile', function () {
      var tile_coords = ($(this).attr('id')).split('_');
      if ($('#view_mode').is(":checked")) {
        return;
      }
      
      if (self.mode === "results") {
        // iterate over all tiles and call predict
        var inference_tile_ids = []
        var inference_tile_urls = []
        $('.tile').each(function(i, tile) {
          tile_coords = ($(tile).attr('id')).split('_');
          inference_tile_ids.push($(tile).attr('id'))
          inference_tile_urls.push(tileCoords2Url(tile_coords[1],tile_coords[3],tile_coords[2]));
        });
        predict(inference_tile_ids,inference_tile_urls);
      } else {
        var concept_name = $("#object_name").val();
        var is_positive = $('#is_positive').is(":checked");
        addConcept(concept_name,is_positive,tile_coords[1],tile_coords[3],tile_coords[2]);
      }
    });

    $('#view_mode').change(function() {
      if($(this).is(":checked")) {
        map.removeLayer(window.grid_layer);
      } else {
        window.grid_layer = L.gridLayer.gridDebug();
        map.addLayer(window.grid_layer);
      }
    });

    map.on("zoomend", function(){
      self.map_curr_zoom = map.getZoom();
    });

    $(document).keypress(function(e) {
      if(e.which == 13) { 
        $('#view_mode').prop('checked', !$('#view_mode').prop("checked"));
      } 
    });

    function getRelatedTiles (z,y,x) {
      // enable view mode
      $('#view_mode').prop('checked', true);
      self.clearCache();

      var image_url = tileCoords2Url(z,y,x);
      
      // fetch visually similar tiles
      app.inputs.search(
        {
          input: {
            url: image_url,
          },
        },
        { page: 1, perPage: 50 }
      ).then(
        function(data) {
          // console.log(JSON.stringify(data));

          data.hits.forEach(function(hit, i) {
            // console.log('---HIT '+i);
            // console.log(hit.input.data.metadata.id);
            
            // highlight the hit tiles & cache them
            $("#"+hit.input.data.metadata.id).addClass("tile_active");
            self.active_tile_cache.push(hit.input.data.metadata.id)
          });
        },
        function(err) {
          console.error(err);
        }
      );
    }

    function addConcept(concept_name,is_positive,z,y,x) {
      // console.log('adding input tile z:'+z+' y:'+y+' x:'+x);
      var tile_id = 'tile_'+z+'_'+x+'_'+y;
      var image_url = 'https://tiledbasemaps.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/'+z+'/'+y+'/'+x+'/current.jpg'
      var image_url_w_token = 'https://tiledbasemaps.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/'+z+'/'+y+'/'+x+'/current.jpg?token='+env.ESRI_APP_TOKEN

      app.inputs.create({
        url: image_url_w_token,
        concepts: [
          {
            id: concept_name,
            value: is_positive
          }
        ],
        metadata: {id: 'tile_'+z+'_'+x+'_'+y, type: 'ags', stage: env.STAGE, size: 256, src:image_url}
      }).then(
        function(response) {
          console.log(response);
          $("#"+tile_id).addClass("tile_active_train");
          self.active_tile_cache.push(tile_id);
        },
        function(err) {
          console.error(err);
        }
      );
    }

    function predictTile(z,y,x) {
      var tile_id = 'tile_'+z+'_'+x+'_'+y;
      var tile_url = tileCoords2Url(z,y,x)
      app.models.predict(env.MODEL_ID, [tile_url]).then(
        function(response) {
          console.log(response);
          response.outputs.forEach(function(output, i) {
            // console.log('---PREDICTION '+i+' --'+tile_id+'--'+tile_url);
            // console.log(output);
            
            // find an accurate concept classification
            var concept_name = undefined;
            output.data.concepts.forEach(function(concept, j) {
              if (concept.value >= 0.7 ) {
                concept_name = concept.name
              }
            });

            if (concept_name) {
              // highlight the inferred tiles & cache them
              $("#"+tile_id).addClass("tile_active");
              self.active_tile_cache.push(tile_id);
              self.searchResults.push({
                image_url: tile_url,
                tile_id: tile_id,
                latitude: $("#"+tile_id).attr('lat'),
                longitude: $("#"+tile_id).attr('lng'),
                name: concept_name
              });
            } else {
              self.inactive_tile_cache.push(tile_id);
            }
          });
        },
        function(err) {
          console.error(err);
        }
      );
    }

    function predict(tile_ids, tile_urls) {
      $('#view_mode').prop('checked', true);
      self.clearCache();

      app.models.predict(env.MODEL_ID, tile_urls).then(
        function(response) {
          console.log(response);

          response.outputs.forEach(function(output, i) {
            // console.log('---PREDICTION '+i+' --'+tile_ids[i]+'--'+tile_urls[i]);
            // console.log(output);

            // find an accurate concept classification
            var concept_name = undefined;
            output.data.concepts.forEach(function(concept, j) {
              // console.log(output);              
              if (concept.value >= 0.7 ) {
                concept_name = concept.name
              }
            });
            // console.log(concept_name);
            if (concept_name) {
              // highlight the inferred tiles & cache them
              $("#"+tile_ids[i]).addClass("tile_active");
              self.active_tile_cache.push(tile_ids[i]);
              self.searchResults.push({
                image_url: tile_urls[i],
                tile_id: tile_ids[i],
                latitude: $("#"+tile_ids[i]).attr('lat'),
                longitude: $("#"+tile_ids[i]).attr('lng'),
                name: concept_name
              });
            } else {
              self.inactive_tile_cache.push(tile_ids[i]);
            }
          });
        },
        function(err) {
          console.error(err);
        }
      );
    }

    function tileCoords2Url(z,y,x) {
      return 'https://tiledbasemaps.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/'+z+'/'+y+'/'+x+'/current.jpg?token='+env.ESRI_APP_TOKEN;
    }
  },
  methods: {
    switchMode: function(m) {
      this.mode = m;
      this.clearCache();
    },
    panMap: function(loc) {
      $('#view_mode').prop('checked', true);
      window.map.removeLayer(window.grid_layer);
      this.clearCache();
      window.map.setView(loc.location, loc.zoom)
    },
    clearCache: function() {
      // clear the cache as we get results for a new root tile
      this.active_tile_cache = []
      this.inactive_tile_cache = []
      this.searchResults = []
      $('.tile').removeClass('tile_active');
      $('.tile').removeClass('tile_active_train');
    },
    createGeojson: function() {
      var featureCollection = {
        "type": "FeatureCollection",
        "features": []
      }

      var feature_name = "";
      this.searchResults.forEach(function(feature, i) {
        var j = {
            "type": "Feature",
            "properties": {
              "marker-color": "#7e7e7e",
              "marker-size": "medium",
              "name": feature.name
            },
            "geometry": {
              "type": "Point",
              "coordinates": [Number(feature.longitude), Number(feature.latitude)]
            }
          };
        feature_name = feature.name;
        featureCollection.features.push(j);
      });
      return this.downloadObject(featureCollection,'geojson_'+feature_name);
    },
    createEsriFeatureSet: function() {
        var featureSet = {
          "spatialReference": {
            "wkid": 4326
          },
          "fields": [
            {
              "alias": "OBJECTID",
              "name": "OBJECTID",
              "type": "esriFieldTypeOID",
              "editable": false
            },
            {
              "alias": "Name",
              "name": "name",
              "length": 255,
              "type": "esriFieldTypeString",
              "editable": true
            },
          ],
          "objectIdField": "OBJECTID",
          "geometryType": "esriGeometryPoint",
          "features": []
        }
        var feature_name = "";
        this.searchResults.forEach(function(feature, i) {
          var j = {
            "geometry": {
              "x": Number(feature.longitude),
              "y": Number(feature.latitude),
              "spatialReference": {
                "wkid": 4326
              }
            },
            "attributes": {
              "OBJECTID": i,
              "name": feature.name
            }
          }
          feature_name = feature.name;
          featureSet.features.push(j);
        });

        return this.downloadObject(featureSet,'featureset_'+feature_name);
    },
    downloadObject: function(exportObj, exportName) {
      var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj));
      var downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href",     dataStr);
      downloadAnchorNode.setAttribute("download", exportName + ".json");
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
    }
  }
}