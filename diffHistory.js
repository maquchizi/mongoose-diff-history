(function() {
  "use strict";
  var History = require("./diffHistoryModel");
  var async = require("async");
  var jsondiffpatch = require("jsondiffpatch").create();

  var saveHistoryObject = function(history, callback) {
    var keysToExclude = ['$setOnInsert', 'modified'];
    keysToExclude.forEach(function(key) {
      if (history.diff[key]) {
        delete history.diff[key];
      }
    });
    history.save(function(err) {
      if (err) {
        err.message = "Mongo Error :" + err.message;
      }
      callback();
    });
  };

  var saveDiffObject = function(currentObject, original, updated, user, reason, callback) {
    var diff = jsondiffpatch.diff(JSON.parse(JSON.stringify(original)),
      JSON.parse(JSON.stringify(updated)));
    if (diff) {
      History.findOne({
        collectionName: currentObject.constructor.modelName,
        collectionId: currentObject._id
      }).sort("-version").exec(function(err, lastHistory) {
        if (err) {
          err.message = "Mongo Error :" + err.message;
          return callback();
        }
        var history = new History({
          collectionName: currentObject.constructor.modelName,
          collectionId: currentObject._id,
          diff: diff,
          user: user,
          reason: reason,
          version: lastHistory ? lastHistory.version + 1 : 0
        });
        saveHistoryObject(history, callback);
      });
    } else {
      callback();
    }
  };

  var saveDiffHistory = function(queryObject, currentObject, callback) {
    currentObject.constructor.findOne({
      _id: currentObject._id
    }, function(err, selfObject) {
      if (selfObject) {
        var dbObject = {},
          updateParams;
        updateParams = queryObject._update["$set"] ? queryObject._update["$set"] : queryObject._update;
        Object.keys(updateParams).forEach(function(key) {
          dbObject[key] = selfObject[key];
        });
        saveDiffObject(currentObject, dbObject, updateParams, queryObject.options.__user, queryObject.options.__reason, function() {
          callback();
        });
      }
    });
  };

  var saveDiffs = function(self, next) {
    var queryObject = self;
    queryObject.find(queryObject._conditions, function(err, results) {
      if (err) {
        err.message = "Mongo Error :" + err.message;
        return next();
      }
      async.eachSeries(results, function(result, callback) {
        if (err) {
          err.message = "Mongo Error :" + err.message;
          return next();
        }
        saveDiffHistory(queryObject, result, callback);
      }, function done() {
        return next();
      });
    });
  };

  var getVersion = function(model, id, version, callback) {
    model.findOne({
      _id: id
    }, function(err, latest) {
      if (err) {
        console.error(err);
        return callback(err, null);
      }
      History.find({
        collectionName: model.modelName,
        collectionId: id,
        version: {
          $gte: parseInt(version, 10)
        }
      }, {
        diff: 1,
        version: 1
      }, {
        sort: "-version"
      }, function(err, histories) {
        if (err) {
          console.error(err);
          return callback(err, null);
        }
        var object = latest ? latest : {};
        async.each(histories, function(history, eachCallback) {
          jsondiffpatch.unpatch(object, history.diff);
          eachCallback();
        }, function(err) {
          if (err) {
            console.error(err);
            return callback(err, null);
          }
          callback(null, object);
        });
      });
    });
  };

  var getHistories = function(modelName, id, expandableFields, callback) {
    History.find({
      collectionName: modelName,
      collectionId: id
    })
    .sort({'createdAt': 'desc'})
    .populate('user').exec(function(err, histories) {
      if (err) {
        return callback(err, null);
      }
      async.map(histories, function(history, mapCallback) {
        var changedValues = [];
        var changedFields = [];

        // Handle cases where there is no diff object
        if (!history.diff) {
          return mapCallback(null, {
            changedBy: null,
            changedAt: null,
            updatedAt: null,
            reason: null,
            comment: null,
            diff: {},
          });
        }

        for (var key in history.diff) {
          if (history.diff.hasOwnProperty(key)) {

            if (expandableFields.indexOf(key) > -1) {
              var oldValue = history.diff[key][0];
              var newValue = history.diff[key][1];
              changedValues.push(key + " from " + oldValue + " to " + newValue);
            } else {
              changedFields.push(key);
            }
          }
        }
        var comment = "modified " + changedFields.concat(changedValues).join(", ");
        return mapCallback(null, {
          changedBy: history.user.profile,
          changedAt: history.createdAt,
          updatedAt: history.updatedAt,
          reason: history.reason,
          comment: comment,
          diff: history.diff,
        })
      }, function(err, output) {
        if (err) {
          return callback(err, null);
        }
        return callback(null, output);
      });
    });
  };

  var plugin = function lastModifiedPlugin(schema, options) {

    schema.pre("save", function(next) {
      var self = this;
      if (self.isNew) {
        next();
      } else {
        self.constructor.findOne({
          _id: self._id
        }, function(err, original) {
          saveDiffObject(self, original, self, self.__user, 'Update', function() {
            next();
          });
        });
      }
    });

    schema.pre("findOneAndUpdate", function(next) {
      this.options.__reason = 'Update';
      saveDiffs(this, function() {
        next();
      });
    });

    schema.pre("update", function(next) {
      this.options.__reason = 'Update';
      saveDiffs(this, function() {
        next();
      });
    });

    schema.pre("remove", function(next) {
      saveDiffObject(this, this, {}, this.__user, 'Delete', function() {
        next();
      })
    });
  };

  module.exports.plugin = plugin;
  module.exports.getHistories = getHistories;
  module.exports.getVersion = getVersion;
})();
