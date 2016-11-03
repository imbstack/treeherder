"use strict";

treeherder.factory('thStringOverlap', function() {
    return function(str1, str2) {
        // Get a measure of the similarity of two strings by a simple process
        // of tokenizing and then computing the ratio of the tokens in common to
        // the total tokens

        var tokens = [str1, str2]
                .map(function (str) {
                    // Replace paths like /foo/bar/baz.html with just the filename baz.html
                    return str.replace(/[^\s]+\/([^\s]+)\s/,
                                       function(m, p1) {
                                           return " " + p1 + " ";
                                       });
                })
                .map(function (str) {
                    // Split into tokens on whitespace / ,  and |
                    return str.split(/[\s\/\,|]+/).filter(function(x) {return x !== "";});
                });

        if (tokens[0].length === 0 || tokens[1].length === 0) {
            return 0;
        }

        var tokenCounts = tokens.map(function(tokens) {
            return _.countBy(tokens, function(x) {return x;});
        });

        var overlap = Object.keys(tokenCounts[0])
                .reduce(function(overlap, x) {
                    if (tokenCounts[1].hasOwnProperty(x)) {
                        overlap += 2 * Math.min(tokenCounts[0][x], tokenCounts[1][x]);
                    }
                    return overlap;
                }, 0);

        return overlap / (tokens[0].length + tokens[1].length);

    };
});

treeherder.factory('ThErrorLineData', [
    function() {
        function ThErrorLineData(line) {
            this.id = line.id;
            this.data = line;
            this.verified = line.best_is_verified;
            this.verifiedIgnore = this.verified && (line.bug_number === 0 ||
                                                    line.best_classification === null);
            this.bestClassification = line.best_classification ?
                line.classified_failures
                .find((cf) => cf.id == line.best_classification) : null;
            this.bugNumber = this.bestClassification ?
                this.bestClassification.bug_number : null;
            this.bugSummary = (this.bestClassification && this.bestClassification.bug) ?
                this.bestClassification.bug.summary : null;
        }
        return ThErrorLineData;
    }
]);

treeherder.factory('ThClassificationOption', ['thExtendProperties',
    function(thExtendProperties) {
        var ThClassificationOption = function(type, id, classifiedFailureId, bugNumber,
                                              bugSummary, bugResolution, matches) {
            thExtendProperties(this, {
                type: type,
                id: id,
                classifiedFailureId: classifiedFailureId || null,
                bugNumber: bugNumber || null,
                bugSummary: bugSummary || null,
                bugResolution: bugResolution || null,
                matches: matches || null,
                isBest: false,
                hidden: false,
                score: null
            });
        };
        return ThClassificationOption;
    }
]);


treeherder.controller('ThClassificationOptionController', [
    '$scope',
    function ($scope) {
        var ctrl = this;

        ctrl.$onChanges = (changes) => {
            console.log('ThClassificationOptionController.$onChanges', ctrl, changes);
            $scope.line = ctrl.errorLine;
            $scope.option = ctrl.optionData;
        };

        $scope.onChange = () => {
            console.log("change");
            ctrl.onChange();
        };
    }
]);

treeherder.component('thClassificationOption', {
    templateUrl: 'plugins/auto_classification/option.html',
    controller: 'ThClassificationOptionController',
    bindings: {
        errorLine: '<',
        optionData: '<',
        selectedOption: '=',
        onChange: '&'
    }
});

treeherder.controller('ThErrorLineController', [
    '$scope', '$rootScope', 'thEvents', 'thValidBugNumber', 'ThClassificationOption', 'thStringOverlap',
    function ($scope, $rootScope, thEvents, thValidBugNumber, ThClassificationOption, thStringOverlap) {
        var ctrl = this;
        var line;
        var optionsById;
        var bestOption;

        $scope.showHidden = false;

        ctrl.$onChanges = (changes) => {
            console.log("ThErrorLineController.$onChanges", ctrl, changes);
            var changed = x => changes.hasOwnProperty(x);
            if (changed("errorMatchers") || changed("errorLine")) {
                build();
            }
            $scope.verified = line.data.best_is_verified;
            $scope.failureLine = line.data.failure_line;
            $scope.searchLine = line.data.bug_suggestions.search;
        };

        function build() {
            line = $scope.line = ctrl.errorLine;
            $scope.options = getOptions();
            console.log("options", $scope.options);
            $scope.extraOptions = getExtraOptions($scope.options);

            var allOptions = $scope.options.concat($scope.extraOptions);

            optionsById = allOptions.reduce((byId, option) => {
                byId.set(option.id, option);
                return byId;
            }, new Map());

            var defaultOption = getDefaultOption($scope.options,
                                                 $scope.extraOptions);
            console.log("defaultOption", defaultOption);
            $scope.selectedOption = {id: defaultOption.id,
                                     manualBugNumber: ""};
            console.log("options", $scope.options);
            $scope.optionChanged();
        }

        function currentOption() {
            return optionsById.get($scope.selectedOption.id);
        }

        $scope.hasHidden = function(options) {
            return options.some((option) => option.hidden);
        };

        $scope.optionChanged = function() {
            console.log("optionChanged");
            var option = $scope.currentOption = currentOption();
            var bug = (option.type === "manual" ? $scope.selectedOption.manualBugNumber :
                       option.bugNumber);
            console.log($scope.currentOption);
            var data = {lineId: line.id,
                        type: option.type,
                        classifiedFailureId: option.classifiedFailureId,
                        bugNumber: bug};
            ctrl.onChange(data);
        };

        function getOptions() {
            var bugSuggestions = [].concat(
                line.data.bug_suggestions.bugs.open_recent,
                line.data.bug_suggestions.bugs.all_others);

            var classificationMatches = getClassifiedFailureMatcher();

            var autoclassifyOptions = line.data.classified_failures
                    .filter((cf) => cf.bug_number !== null && cf.bug_number !== 0)
                    .map((cf) => new ThClassificationOption("classifiedFailure",
                                                            line.id + "-" + cf.id,
                                                            cf.id,
                                                            cf.bug_number,
                                                            cf.bug ? cf.bug.summary : "",
                                                            cf.bug ? cf.bug.resolution : "",
                                                            classificationMatches(cf.id)));

            var autoclassifiedBugs = line.data.classified_failures
                    .reduce(function(classifiedBugs, cf) {
                        if (cf.bug_number) {
                            classifiedBugs.add(cf.bugNumber);
                        }
                        return classifiedBugs;
                    }, new Set());

            var bugSuggestionOptions = bugSuggestions
                    .filter((bug) => !autoclassifiedBugs.has(bug.id))
                    .map((bugSuggestion) => new ThClassificationOption("unstructuredBug",
                                                                       line.id + "-" + "ub-" + bugSuggestion.id,
                                                                       null,
                                                                       bugSuggestion.id,
                                                                       bugSuggestion.summary,
                                                                       bugSuggestion.resolution));

            bestOption = null;

            // Look for an option that has been marked as the best classification.
            // This is always sorted first and never hidden, so we remove it and readd it.
            if (!bestIsIgnore()) {
                var bestIndex = line.data.best_classification ?
                        autoclassifyOptions
                        .findIndex((cf) => cf.id === line.data.best_classification) : -1;

                if (bestIndex > -1) {
                    bestOption = autoclassifyOptions[bestIndex];
                    bestOption.isBest = true;
                    autoclassifyOptions.splice(bestIndex, 1);
                }
            }

            var options = autoclassifyOptions.concat(bugSuggestionOptions);
            scoreOptions(options);
            sortOptions(options);

            if (bestOption) {
                options.unshift(bestOption);
            }

            markHidden(options);

            return options;
        }

        function getExtraOptions() {
            var extraOptions = [];
            // Don't add a manual option if the autoclassifier picked an option
            // with no bug number
            if (!bestOption || bestOption.bugNumber !== null) {
                extraOptions.push(new ThClassificationOption("manual", line.id + "-manual"));
            }
            var ignoreOption = new ThClassificationOption("ignore", line.id + "-ignore", 0);
            extraOptions.push(ignoreOption);
            if (bestIsIgnore()) {
                ignoreOption.isBest = true;
            }
            return extraOptions;
        }

        function bestIsIgnore() {
            return (line.data.best_classification &&
                    line.data.best_classification.bugNumber === 0);
        }

        function scoreOptions(options) {
            options
                .forEach((option) => {
                    var score;
                    if (options.matches) {
                        score = this.matches
                            .reduce((prev, cur) => cur.score > prev ? cur : prev, 0);
                    } else {
                        score = thStringOverlap(line.data.bug_suggestions.search,
                                                option.bugSummary);
                        // Artificially reduce the score of resolved bugs
                        score *= option.bugResolution ? 0.8 : 1;
                    }
                    option.score = score;
                });
        }

        function sortOptions(options) {
            // Sort all the possible failure line options by their score
            options.sort((a, b) => b.score - a.score);
        }

        function markHidden(options) {
            // Mark some options as hidden by default
            // We do this if the score is too low compared to the best option
            // of if the score is below some threshold or if there are too many
            // options

            console.log("markHidden");
            if (!options.length) {
                return;
            }

            var bestOption = options[0];

            console.log(bestOption);

            var lowerCutoff = 0.1;
            var bestRatio = 0.5;
            var maxOptions = 10;
            var minOptions = 3;

            var bestScore = bestOption.score;

            options.forEach((option, idx) => {
                option.hidden = idx > (minOptions - 1) &&
                    (option.score < lowerCutoff ||
                     option.score < bestRatio * bestScore ||
                     idx > (maxOptions - 1));
                console.log("Hidden", option, option.hidden);
            });
        }

        function getClassifiedFailureMatcher() {
            var matchesByCF = line.data.matches.reduce(
                function(matchesByCF, match) {
                    if (!matchesByCF.has(match.classified_failure)) {
                        matchesByCF.set(match.classified_failure, []);
                    }
                    matchesByCF.get(match.classified_failure).push(match);
                    return matchesByCF;
                }, new Map());

            return function(cf_id) {
                return matchesByCF.get(cf_id).map(
                    function(match) {
                        return {
                            matcher: ctrl.errorMatchers.get(match.matcher),
                            score: match.score
                        };
                    });
            };
        }

        function getDefaultOption(options, extraOptions) {
            if (bestOption) {
                return bestOption;
            }
            if (!options.length) {
                return extraOptions[0];
            }
            return options[0];
        }

        ctrl.onEventIgnore = function() {
            if (!ctrl.isSelected) {
                return;
            }
            var id = line.id + "-ignore";
            if (id !== $scope.selectedOption.id) {
                $scope.selectedOption.id = id;
                $scope.optionChanged();
            }
        };

        ctrl.onEventSelectOption = function(option) {
            if (!ctrl.isSelected) {
                return;
            }
            var id;
            if (option === "=") {
                id = line.id + "-manual";
            } else {
                var idx = parseInt(option);
                if ($scope.options[idx]) {
                    id = $scope.options[idx].id;
                }
            }
            if (!optionsById.has(id)) {
                return;
            }
            if (id !== $scope.selectedOption.id) {
                $scope.selectedOption.id = id;
                $scope.optionChanged();
            }
            if (option === "=") {
                $("#" + line.id + "-manual-bug").focus();
            }
        };

        ctrl.onEventToggleExpandOptions = function() {
            console.log("onToggleExpandOptions", ctrl.isSelected);
            if (!ctrl.isSelected) {
                return;
            }
            $scope.showHidden = !$scope.showHidden;
        };

        $rootScope.$on(thEvents.autoclassifySelectOption,
                       (ev, key) => ctrl.onEventSelectOption(key));

        $rootScope.$on(thEvents.autoclassifyIgnore,
                       () => ctrl.onEventIgnore());

        $rootScope.$on(thEvents.autoclassifyToggleExpandOptions,
                       () => ctrl.onEventToggleExpandOptions());
    }
]);

treeherder.component('thErrorLine', {
    templateUrl: 'plugins/auto_classification/errorLine.html',
    controller: 'ThErrorLineController',
    bindings: {
        errorMatchers: '<',
        errorLine: '<',
        isSelected: '<',
        onChange: '&'
    }
});

treeherder.controller('ThAutoclassifyErrorsController', ['$scope', '$element',
    function ($scope, $element) {
        var ctrl = this;

        ctrl.$onChanges = function(changes) {
            console.log("thAutoclassifyErrorsController.$onChange", ctrl, changes);
        };

        $scope.toggleSelect = function(event, id) {
            console.log(event);
            var target = $(event.target);
            var elem = target;
            var interactive = new Set(["INPUT", "BUTTON", "TEXTAREA", "A"]);
            while (elem.length && elem[0] !== $element[0]) {
                if (interactive.has(elem.prop("tagName"))) {
                    return;
                }
                elem = elem.parent();
            }
            ctrl.onToggleSelect({lineId: id, clear: !event.ctrlKey});
        };
    }
]);

treeherder.component('thAutoclassifyErrors', {
    templateUrl: 'plugins/auto_classification/errors.html',
    controller: "ThAutoclassifyErrorsController",
    bindings: {
        loadStatus: '<',
        errorMatchers: '<',
        errorLines: '<',
        selectedLineIds: '<',
        onUpdateLine: '&',
        onToggleSelect: '&'
    }
});

treeherder.controller('ThAutoclassifyToolbarController', [
    function() {
        var ctrl = this;

        ctrl.$onChanges = function(changes) {
            console.log("thAutoclassifyToolbarController.$onChanges", ctrl, changes);
        };
    }
]);

treeherder.component('thAutoclassifyToolbar', {
    templateUrl: 'plugins/auto_classification/toolbar.html',
    controller: "ThAutoclassifyToolbarController",
    bindings: {
        loadStatus: '<',
        autoclassifyStatus: '<',
        loggedIn: '<',
        canSave: '<',
        canSaveAll: '<',
        hasSelection: '<',
        onIgnore: '&',
        onSave: '&',
        onSaveAll: '&'
    }
});

treeherder.controller('ThAutoclassifyPanelController', [
    '$scope', '$rootScope', '$q', '$timeout', 'thEvents', 'thJobNavSelectors', 'ThMatcherModel',
    'ThTextLogErrorsModel', 'ThErrorLineData',
    function($scope, $rootScope, $q, $timeout, thEvents, thJobNavSelectors, ThMatcherModel,
             ThTextLogErrorsModel, ThErrorLineData) {

        var ctrl = this;

        var requestPromise = null;

        var linesById = null;

        var autoclassifyStatusOnLoad = null;

        var stateByLine = null;

        ctrl.$onChanges = (changes) => {
            var changed = x => changes.hasOwnProperty(x);
            console.log("thAutoclassifyPanelController.$onChanges", ctrl, changes);

            if (changed("job")) {
                if (ctrl.job.id) {
                    jobChanged();
                }
            } else if (changed("hasLogs") || changed("logsParsed") ||
                       changed("logParseStatus") || changed("autoclassifyStatus")) {
                build();
            }
        };

        function jobChanged() {
            linesById = new Map();
            ctrl.selectedLineIds = new Set();
            stateByLine = new Map();
            autoclassifyStatusOnLoad = null;
            build();
        }

        function build() {
            console.log("thAutoclassifyPanelController.build", ctrl);
            console.log("Status", ctrl.loadStatus);
            if (!ctrl.logsParsed || ctrl.autoclassifyStatus === "pending") {
                ctrl.loadStatus = "pending";
            } else if (ctrl.logParsingFailed) {
                ctrl.loadStatus = "failed";
            } else if (!ctrl.hasLogs) {
                ctrl.loadStatus = "no_logs";
            } else if ((autoclassifyStatusOnLoad === null ||
                        autoclassifyStatusOnLoad === "cross_referenced")) {
                if (ctrl.loadStatus !== "ready") {
                    ctrl.loadStatus = "loading";
                }
                fetchErrorData()
                    .then(data => buildLines(data))
                    .catch((err) => {
                        console.log("load failed");
                        console.log(err);
                        ctrl.loadStatus = "error";
                    });
            }
        }

        function buildLines(data) {
            console.log(data);
            $scope.errorMatchers = data.matchers;
            loadData(data.error_lines);
            $scope.errorLines
                .forEach((line) => stateByLine.set(
                    line.id,
                    {classifiedFailureId: null,
                     bugNumber: null,
                     type: null}));
            requestPromise = null;
            ctrl.loadStatus = "ready";
            // Store the autoclassify status so that we only retry
            // the load when moving from 'cross_referenced' to 'autoclassified'
            autoclassifyStatusOnLoad = ctrl.autoclassifyStatus;
            // Preselect the first line
            if ($scope.errorLines.length) {
                ctrl.selectedLineIds.add($scope.errorLines[0].id);
            }
        }

        function fetchErrorData() {
            // if there's a ongoing request, abort it
            if (requestPromise !== null) {
                requestPromise.resolve();
            }

            requestPromise = $q.defer();

            console.log("making request", ctrl.job);
            var resources = {
                "matchers": ThMatcherModel.by_id(),
                "error_lines": ThTextLogErrorsModel.getList(ctrl.job.id,
                                                            {timeout: requestPromise})
            };
            return $q.all(resources);
        }

        function loadData(lines) {
            console.log("loadData", lines);
            linesById = lines
                .reduce((byId, line) => {
                    byId.set(line.id, new ThErrorLineData(line));
                    return byId;}, linesById);
            $scope.errorLines = Array.from(linesById.values());
            // Resort the lines to allow for in-place updates
            $scope.errorLines.sort((a, b) => b.data.id - a.data.id);
        }

        ctrl.onSaveAll = function() {
            save($scope.pendingLines());
        };

        ctrl.onSave = function() {
            save($scope.selectedLines());
        };

        ctrl.onIgnore = function() {
            $rootScope.$emit(thEvents.autoclassifyIgnore);
        };

        ctrl.onUpdateLine = function(lineId, type, classifiedFailureId, bugNumber) {
            console.log("onUpdateLine");
            var state = stateByLine.get(lineId);
            state.type = type;
            state.classifiedFailureId = classifiedFailureId;
            state.bugNumber = bugNumber;
        };

        ctrl.onToggleSelect = function(lineId, clear) {
            console.log("thAutoclassifyPanelController.onSelectLine", lineId);
            var isSelected = ctrl.selectedLineIds.has(lineId);
            if (clear) {
                ctrl.selectedLineIds.clear();
            }
            if (isSelected) {
                ctrl.selectedLineIds.delete(lineId);
            } else {
                ctrl.selectedLineIds.add(lineId);
            }
            console.log(ctrl.selectedLineIds);
        };

        ctrl.onChangeSelection = function(direction, clear) {
            console.log("onChangeSelection", direction, clear);
            var optionIndexes = $scope.errorLines
                    .reduce((idxs, x, i) => idxs.set(x.id, i), new Map());
            var selected = $scope.selectedLines();
            console.log("onChangeSelection", optionIndexes, selected);
            var idx;
            if (direction === "next") {
                if (selected) {
                    idx = optionIndexes.get(selected[selected.length - 1].id) + 1;
                } else {
                    idx = 0;
                }
            } else if (direction === "previous") {
                if (selected) {
                    idx = optionIndexes.get(selected[0].id) - 1;
                } else {
                    idx = -1;
                }
            }
            console.log("onChangeSelection", idx);
            if (clear) {
                // Move to the next or previous panels if we moved out of bounds
                if (idx > $scope.errorLines.length - 1) {
                    $rootScope.$emit(thEvents.changeSelection,
                                     'next',
                                     thJobNavSelectors.UNCLASSIFIED_FAILURES);
                    return;
                } else if (idx < 0) {
                    $rootScope.$emit(thEvents.changeSelection,
                                     'previous',
                                     thJobNavSelectors.UNCLASSIFIED_FAILURES);
                    return;
                }
            }
            var lineId = $scope.errorLines[idx].id;
            ctrl.onToggleSelect(lineId, clear);
            $("th-autoclassify-errors th-error-line")[idx].scrollIntoView({behaviour: "smooth",
                                                                           block: "end"});
        };

        function canSave(lineId) {
            if (!ctrl.loggedIn) {
                return false;
            }
            var state = stateByLine.get(lineId);
            if (state.type === null) {
                return false;
            }
            if (state.type === "ignore") {
                return true;
            }
            return state.classifiedFailureId || state.bugNumber;
        };

        $scope.canSave = function(lines) {
            console.log("canSave", lines);
            return (ctrl.loggedIn && lines.length &&
                    lines.every(line => canSave(line.id)));
        };

        function save(lines) {
            var data = lines.map((line) => {
                var state = stateByLine.get(line.id);
                var bestClassification = state.classifiedFailureId || null;
                var bugNumber = state.bugNumber;
                return {id: line.id,
                        best_classification: bestClassification,
                        bug_number: bugNumber};
            });
            console.log("save", data);
            ThTextLogErrorsModel
                .verifyMany(data)
                .then((resp) => loadData(resp.data));
        }

        $scope.pendingLines = lineFilterFunc((line) => line.verified === false);

        $scope.selectedLines = lineFilterFunc((line) => ctrl.selectedLineIds.has(line.id));

        function lineFilterFunc(filterFunc) {
            return () => {
                if (!$scope.errorLines) {
                    return [];
                };
                return $scope.errorLines.filter(filterFunc);
            };
        };

        $rootScope.$on(thEvents.autoclassifyChangeSelection,
                       (ev, direction, clear) => ctrl.onChangeSelection(direction, clear));

        $rootScope.$on(thEvents.autoclassifySaveAll,
                       (ev) => ctrl.onSaveAll());

        $rootScope.$on(thEvents.autoclassifySave,
                       (ev) => ctrl.onSave());
    }
]);

treeherder.component('thAutoclassifyPanel', {
    templateUrl: 'plugins/auto_classification/panel.html',
    controller: 'ThAutoclassifyPanelController',
    bindings: {
        job: '<',
        hasLogs: '<',
        logsParsed: '<',
        logParseStatus: '<',
        autoclassifyStatus: '<',
        loggedIn: '<'
    }
});
