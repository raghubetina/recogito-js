import React, { Component } from 'react';
import { Editor } from '@recogito/recogito-client-core';
import Highlighter from './highlighter/Highlighter';
import SelectionHandler from './selection/SelectionHandler';
import RelationsLayer from './relations/RelationsLayer';
import RelationEditor from './relations/editor/RelationEditor';

import './TextAnnotator.scss';

/**
 * Pulls the strings between the annotation highlight layer
 * and the editor popup.
 */
export default class TextAnnotator extends Component {

  constructor(props) {
    super(props);

    this.state = {
      selectedAnnotation: null,
      selectedDOMElement: null,
      selectedRelation: null,

      // ReadOnly mode
      readOnly: this.props.config.readOnly,

      widgets: this.props.config.widgets,

      // Headless mode
      editorDisabled: this.props.config.disableEditor,
    }

    this._editor = React.createRef();
  }

  /** Shorthand **/
  clearState = () => {
    this.setState({
      selectedAnnotation: null,
      selectedDOMElement: null
    });

    this.selectionHandler.enabled = true;
  }

  handleEscape = (evt) => {
    if (evt.which === 27)
      this.onCancelAnnotation();
  }

  componentDidMount() {
    this.highlighter = new Highlighter(this.props.contentEl, this.props.config.formatter);

    this.selectionHandler = new SelectionHandler(this.props.contentEl, this.highlighter, this.props.config.readOnly);
    this.selectionHandler.on('select', this.handleSelect);

    this.relationsLayer = new RelationsLayer(this.props.contentEl);

    this.relationsLayer.on('createRelation', this.onEditRelation);
    this.relationsLayer.on('selectRelation', this.onEditRelation);
    this.relationsLayer.on('cancelDrawing', this.closeRelationsEditor);

    document.addEventListener('keydown', this.handleEscape);
  }

  componentWillUnmount() {
    document.removeEventListener('keydown', this.handleEscape);
  }

  onChanged = () => {
    // Disable selection outside of the editor 
    // when user makes the first change
    this.selectionHandler.enabled = false;
  }

  /**************************/
  /* Annotation CRUD events */
  /**************************/

  /** Selection on the text **/
  handleSelect = evt => {
    this.state.editorDisabled ?
      this.onHeadlessSelect(evt) : this.onNormalSelect(evt);
  }

  onNormalSelect = evt => {
    const { selection, element } = evt;
    if (selection) {
      this.setState({
        selectedAnnotation: null,
        selectedDOMElement: null
      }, () => this.setState({
        selectedAnnotation: selection,
        selectedDOMElement: element
      }));

      if (!selection.isSelection)
        this.props.onAnnotationSelected(selection.clone(), element);
    } else {
      this.clearState();
    }
  }

  onHeadlessSelect = evt => {
    const { selection, element } = evt;
    if (selection) {
      this.setState({
        selectedAnnotation: null,
        selectedDOMElement: null
      }, () => this.setState({
        selectedAnnotation: selection,
        selectedDOMElement: element
      }));

      if (!selection.isSelection) {
        // Selection of existing annotation
        this.props.onAnnotationSelected(selection.clone(), element);
      } else {
        // Notify backend text selection to create a new annotation
        const undraft = annotation =>
        annotation.clone({
          body : annotation.bodies.map(({ draft, ...rest }) => rest)
        });
        this.onCreateOrUpdateAnnotation('onAnnotationCreated')(undraft(selection).toAnnotation());
      }
    } else {
      this.clearState();
    }
  }

  /**
   * A convenience method that allows the external application to
   * override the autogenerated Id for an annotation.
   *
   * Usually, the override will happen almost immediately after
   * the annotation is created. But we need to be defensive and assume
   * that the override might come in with considerable delay, thus
   * the user might have made further edits already.
   *
   * A key challenge here is that there may be dependencies between
   * the original annotation and relations that were created meanwhile.
   */
  overrideAnnotationId = originalAnnotation => forcedId => {
    const { id } = originalAnnotation;

    // After the annotation update, we need to update dependencies
    // on the annotation layer, if any
    const updateDependentRelations = updatedAnnotation => {
      // Wait until the highlighter update has come into effect
      requestAnimationFrame(() => {
        this.relationsLayer.overrideTargetAnnotation(originalAnnotation, updatedAnnotation);
      })
    };

    // Force the editors to close first, otherwise their annotations will be orphaned
    if (this.state.selectedAnnotation || this.state.selectedRelation) {
      this.relationsLayer.resetDrawing();
      this.setState({
        selectedAnnotation: null,
        selectedRelation: null
      }, () => {
        const updated = this.highlighter.overrideId(id, forcedId);
        updateDependentRelations(updated);
      });
    } else {
      const updated = this.highlighter.overrideId(id, forcedId);
      updateDependentRelations(updated);
    }
  }

  /**
   * A convenience method that allows the external application to
   * override the autogenerated Id for a relation.
   *
   * This operation is less problematic than .overrideAnnotation().
   * We just need to make sure the RelationEditor is closed, so that
   * the annotation doesn't become orphaned. Otherwise, there are
   * no dependencies.
   */
  overrideRelationId = originalId => forcedId => {
    if (this.state.selectedRelation) {
      this.setState({ selectedRelation: null }, () =>
       this.relationsLayer.overrideRelationId(originalId, forcedId));
    } else {
      this.relationsLayer.overrideRelationId(originalId, forcedId);
    }
  }

  /** Common handler for annotation CREATE or UPDATE **/
  onCreateOrUpdateAnnotation = method => (annotation, previous) => {
    const updatedAnnotation = annotation.clone();
    this.highlighter.addOrUpdateAnnotation(updatedAnnotation, previous);

    this.props[method](updatedAnnotation, previous ? previous.clone() : null);

    this.setState({
      selectedAnnotation: updatedAnnotation,
      selectedDOMElement: this.highlighter.findAnnotationSpans(updatedAnnotation)[0]
    });
  }

  onDeleteAnnotation = annotation => {
    // Delete connections
    this.relationsLayer.destroyConnectionsFor(annotation);

    this.clearState();
    this.selectionHandler.clearSelection();
    this.highlighter.removeAnnotation(annotation);

    this.props.onAnnotationDeleted(annotation);
  }

  /** Cancel button on annotation editor **/
  onCancelAnnotation = annotation => {
    this.clearState();
    this.selectionHandler.clearSelection();
    this.props.onCancelSelected(annotation);
  }

  /************************/
  /* Relation CRUD events */
  /************************/

  // Shorthand
  closeRelationsEditor = () => {
    this.setState({ selectedRelation: null });
    this.relationsLayer.resetDrawing();
  }

  /**
   * Selection on the relations layer: open an existing
   * or newly created connection for editing.
   */
  onEditRelation = relation => {
    this.setState({
      selectedRelation: relation
    });
  }

  /** 'Ok' on the relation editor popup **/
  onCreateOrUpdateRelation = (relation, previous) => {
    this.relationsLayer.addOrUpdateRelation(relation, previous);
    this.closeRelationsEditor();

    // This method will always receive a 'previous' connection -
    // if the previous is just an empty connection, fire 'create',
    // otherwise, fire 'update'
    const isNew = previous.annotation.bodies.length === 0;

    if (isNew)
      this.props.onAnnotationCreated(relation.annotation.clone(), this.overrideRelationId(relation.annotation.id));
    else
      this.props.onAnnotationUpdated(relation.annotation.clone(), previous.annotation.clone());
  }

  /** 'Delete' on the relation editor popup **/
  onDeleteRelation = relation => {
    this.relationsLayer.removeRelation(relation);
    this.closeRelationsEditor();
    this.props.onAnnotationDeleted(relation.annotation);
  }

  /****************/
  /* External API */
  /****************/

  addAnnotation = annotation => {
    this.highlighter.addOrUpdateAnnotation(annotation.clone());
  }

  get disableSelect() {
    return !this.selectionHandler.enabled;
  }

  set disableSelect(disable) {
    if (disable)
      this.props.contentEl.classList.add('r6o-noselect');
    else
      this.props.contentEl.classList.remove('r6o-noselect');

    this.selectionHandler.enabled = !disable;
  }

  getAnnotations = () => {
    const annotations = this.highlighter.getAllAnnotations();
    const relations = this.relationsLayer.getAllRelations();
    return annotations.concat(relations).map(a => a.clone());
  }

  removeAnnotation = annotation => {
    this.highlighter.removeAnnotation(annotation);

    // If the editor is currently open on this annotation, close it
    const { selectedAnnotation } = this.state;
    if (selectedAnnotation && annotation.isEqual(selectedAnnotation))
      this.clearState();
  }

  selectAnnotation = arg => {
    // De-select in any case
    this.setState({
      selectedAnnotation: null,
      selectedDOMElement: null
    }, () => {
      if (arg) {
        const spans = this.highlighter.findAnnotationSpans(arg);

        if (spans.length > 0) {
          const selectedDOMElement = spans[0];
          const selectedAnnotation = spans[0].annotation;

          this.setState({
            selectedAnnotation,
            selectedDOMElement
          });
        }
      }
    });
  }

  setAnnotations = annotations => {
    this.highlighter.clear();
    this.relationsLayer.clear();

    const clones = annotations.map(a => a.clone());

    return this.highlighter.init(clones).then(() =>
      this.relationsLayer.init(clones));
  }

  setMode = mode => {
    if (mode === 'RELATIONS') {
      this.clearState();

      this.selectionHandler.enabled = false;

      this.relationsLayer.readOnly = false;
      this.relationsLayer.startDrawing();
    } else {
      this.setState({ selectedRelation: null });

      this.selectionHandler.enabled = true;

      this.relationsLayer.readOnly = true;
      this.relationsLayer.stopDrawing();
    }
  }

  get readOnly() {
    return this.state.readOnly;
  }

  set readOnly(readOnly) {
    this.selectionHandler.readOnly = readOnly;
    // Note: relationsHandler.readOnly should be set by setMode.
    this.setState({ readOnly });
  }

  get widgets() {
    return this.state.widgets;
  }

  set widgets(widgets) {
    this.setState({ widgets });
  }

  get disableEditor() {
    return this.state.editorDisabled;
  }

  set disableEditor(disabled) {
    this.setState({ editorDisabled: disabled });
  }

  render() {
  	// The editor should open under normal conditions - annotation was selected, no headless mode
    const open = (this.state.selectedAnnotation || this.state.selectedRelation) && !this.state.editorDisabled;

    const readOnly = this.state.readOnly || this.state.selectedAnnotation?.readOnly;

    return (open && (
      <>
        { this.state.selectedAnnotation &&
          <Editor
            ref={this._editor}
            annotation={this.state.selectedAnnotation}
            selectedElement={this.state.selectedDOMElement}
            autoPosition={this.props.config.editorAutoPosition}
            wrapperEl={this.props.wrapperEl}
            readOnly={readOnly}
            allowEmpty={this.props.config.allowEmpty}
            widgets={this.state.widgets}
            env={this.props.env}
            onChanged={this.onChanged}
            onAnnotationCreated={this.onCreateOrUpdateAnnotation('onAnnotationCreated')}
            onAnnotationUpdated={this.onCreateOrUpdateAnnotation('onAnnotationUpdated')}
            onAnnotationDeleted={this.onDeleteAnnotation}
            onCancel={this.onCancelAnnotation} />
        }
        { this.state.selectedRelation &&
          <RelationEditor
            relation={this.state.selectedRelation}
            onRelationCreated={this.onCreateOrUpdateRelation}
            onRelationUpdated={this.onCreateOrUpdateRelation}
            onRelationDeleted={this.onDeleteRelation}
            onCancel={this.closeRelationsEditor}
            vocabulary={this.props.relationVocabulary}
          />
        }
      </>
    ));
  }

}
