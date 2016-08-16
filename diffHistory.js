var History = require('./diffHistoryModel');
var async = require('async');
var jsondiffpatch = require('./node_modules/jsondiffpatch/src/main').create();

var plugin = function lastModifiedPlugin(schema, options) {

    schema.pre('save', function (next) {
        var self = this;
        if(self.isNew) {next();return;}
        self.constructor.findOne({_id: self._id}, function (err, original) {
            saveDiffObject(self, original, self, self.__user, self.__reason, function(){
                next();
            });
        });
    });

    schema.pre('findOneAndUpdate', function (next) {
        saveDiffs(this, next);
    });

    schema.pre('update', function (next) {
        saveDiffs(this, next);
    });
};

var saveDiffs = function(self, next) {
    var queryObject = self;
    queryObject.find(queryObject._conditions, function (err, results) {
        if (err) {
            err.message = "Mongo Error :" + err.message;
            return next();
        }
        async.eachSeries(results, function (result, callback) {
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

var saveDiffHistory = function(queryObject, currentObject, callback) {
    currentObject.constructor.findOne({_id: currentObject._id}, function (err, selfObject) {
        if(selfObject){

            var dbObject = {}, updateParams;
            updateParams = queryObject._update['$set'] ? queryObject._update['$set'] : queryObject._update;
            Object.keys(updateParams).forEach(function(key) {
                dbObject[key] = selfObject[key];
            });
            saveDiffObject(currentObject, dbObject, updateParams, queryObject.options.__user, queryObject.options.__reason, function(){
                callback();
            });
        }
    });
};

var saveDiffObject = function(currentObject, original, updated, user, reason, callback){
    var diff = jsondiffpatch.diff(JSON.parse(JSON.stringify(original)),
        JSON.parse(JSON.stringify(updated)));
    if (diff) {
        var history = new History({
            collectionName: currentObject.constructor.modelName,
            collectionId: currentObject._id,
            diff: diff,
            user: user,
            reason: reason
        });
        history.save(function(err) {
            if (err){
                err.message = "Mongo Error :" + err.message;
            }
            callback();
        });
    }
    else{
        callback();
    }
};

var getHistories = function (modelName, id, exapndableFields, callback) {
    History.find({collectionName: modelName, collectionId: id}, function (err, historys) {
        if (err) {
            console.error(err);
            return callback(err, null);
        }
        async.map(historys, function (history, mapCallback) {
            var changedValues = [];
            var changedFields = [];
            for (var key in history.diff) {
                if (history.diff.hasOwnProperty(key)) {

                    if (exapndableFields.indexOf(key) > -1) {
                        //var oldDate = new Date(history.diff[key][0]);
                        //var newDate = new Date(history.diff[key][1]);
                        //if (oldDate != 'Invalid Date' && newDate != 'Invalid Date') {
                        //    oldValue = oldDate.getFullYear() + '-' + (oldDate.getMonth() + 1) + '-' + oldDate.getDate();
                        //    newValue = newDate.getFullYear() + '-' + (newDate.getMonth() + 1) + '-' + newDate.getDate();
                        //}
                        //else {
                        oldValue = history.diff[key][0];
                        newValue = history.diff[key][1];
                        //}
                        changedValues.push(key + " from " + oldValue + " to " + newValue);
                    }
                    else {
                        changedFields.push(key);
                    }
                }
            }
            var comment = 'modified ' + changedFields.concat(changedValues).join(', ');
            return mapCallback(null, {
                changedBy: history.user,
                changedAt: history.created_at,
                reason: history.reason,
                commment: comment
            })
        }, function (err, output) {
            if (err) {
                Logger.error(err);
                return callback(err, null);
            }
            return callback(null, output);
        });
    });
};

module.exports.plugin = plugin;
module.exports.getHistories = getHistories;